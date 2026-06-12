import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "./error";

// [console fork] SSRF guard for outbound fetches to operator/tenant-supplied URLs (third-party-auth
// JWKS/issuer discovery, audit-log webhook drains). Require https and reject any URL that targets
// the loopback / link-local / private network — so a tenant admin can't make the control plane
// probe its internal network or, critically on EC2, steal the instance IAM credentials from the
// 169.254.169.254 metadata endpoint.
//
// The literal block-list (isPublicHttpsUrl) is the fast validation-time check. It also rejects
// alternate IP encodings (decimal/hex/octal, IPv4-mapped IPv6) that resolve to those ranges but
// don't match a dotted-quad literal — a classic guard bypass (https://2852039166 == 169.254.169.254).
// assertFetchableUrl additionally RESOLVES the hostname and re-checks every resolved address, which
// is the authoritative boundary (covers a public hostname that resolves to a private IP). Call it
// immediately before the fetch.

// Is a NORMALIZED IP literal (v4 dotted-quad or v6) in a non-public range?
export function isPrivateIp(addr: string): boolean {
  let ip = addr.toLowerCase().replace(/^\[|\]$/g, "");

  // IPv4-mapped / -compatible IPv6 (::ffff:1.2.3.4 or ::ffff:7f00:1) — evaluate as the v4 inside.
  const mapped = ip.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) ip = mapped[1]!;
  const mappedHex = ip.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    ip = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }

  const v = isIP(ip);
  if (v === 4) {
    const o = ip.split(".").map(Number);
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed → unsafe
    const [a, b] = o as [number, number, number, number];
    if (a === 127 || a === 10 || a === 0) return true; // loopback, private, "this host"
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (v === 6) {
    if (ip === "::1" || ip === "::") return true; // loopback / unspecified
    if (ip.startsWith("fe80:") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) return true; // link-local fe80::/10
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // unique-local fc00::/7
    return false;
  }
  return false; // not an IP literal — a hostname; resolved separately
}

export function isPublicHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false; // creds in the URL → reject (also an SSRF/credential vector)

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;

  // A literal IP (any notation): block if private. isIP only recognises canonical forms, so also
  // reject non-DNS hostnames that are bare numbers / hex — packed IPv4 encodings of private IPs
  // (e.g. 2852039166 or 0x7f000001) that would otherwise slip past the dotted-quad checks.
  if (isIP(host) !== 0 || host.includes(":")) {
    if (isPrivateIp(host)) return false;
  } else if (/^(0x[0-9a-f]+|\d+|0[0-7]+(\.\d+)*)$/i.test(host)) {
    return false; // numeric/hex/octal hostname — not a real domain, an IP literal in disguise
  }

  return true;
}

/** Throws a 400 AppError if the URL isn't a public https URL (synchronous, literal checks only). */
export function assertPublicHttpsUrl(raw: string): void {
  if (!isPublicHttpsUrl(raw)) {
    throw new AppError(
      400,
      "blocked_url",
      "URL must be a public https URL (loopback/link-local/private hosts are not allowed)"
    );
  }
}

/**
 * Authoritative SSRF check — call IMMEDIATELY before fetching. Runs the literal checks, then
 * resolves the hostname and rejects if ANY resolved address is in a non-public range (catches a
 * public hostname that resolves to a private IP, and DNS-normalised alternate encodings). Throws
 * a 400 AppError on rejection or if the host can't be resolved.
 */
export async function assertFetchableUrl(raw: string): Promise<void> {
  assertPublicHttpsUrl(raw);
  const host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // A literal IP already passed isPrivateIp above; no DNS to do.
  if (isIP(host) !== 0) return;
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new AppError(400, "blocked_url", "Could not resolve the URL host");
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new AppError(400, "blocked_url", "URL host resolves to a non-public address");
  }
}
