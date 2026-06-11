import { AppError } from "./error";

// [console fork] SSRF guard for outbound fetches to operator/tenant-supplied URLs (third-party-auth
// JWKS/issuer discovery, audit-log webhook drains). Require https and reject loopback, link-local
// (incl. the 169.254.169.254 cloud-metadata endpoint), and private IP literals — so a tenant admin
// can't make the control plane probe its internal network or steal instance IAM credentials.
//
// Residual: DNS-rebinding via a public hostname that resolves to a private IP isn't covered here
// (that needs a resolve-then-pin at connect time); the high-value literal targets are blocked.
export function isPublicHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isIpv6 = host.includes(":");

  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (isIpv6 && (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd"))) {
    return false;
  }
  if (/^(127\.|10\.|169\.254\.|0\.)/.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;

  return true;
}

/** Throws a 400 AppError if the URL isn't a public https URL. */
export function assertPublicHttpsUrl(raw: string): void {
  if (!isPublicHttpsUrl(raw)) {
    throw new AppError(
      400,
      "blocked_url",
      "URL must be a public https URL (loopback/link-local/private hosts are not allowed)"
    );
  }
}
