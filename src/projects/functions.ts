import { readdir, readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { SSMClient } from "@aws-sdk/client-ssm";
import type { Project } from "../db/schema";
import { projectDir } from "./stack/writer";
import { getCredentials } from "../aws/credentials-service";
import { runCommand } from "./ec2-ssm";
import { AppError } from "../http/error";

// [console fork] Edge functions management. The project's functions VOLUME is the source of
// truth (it's what the edge-runtime serves), so the dashboard reads/writes it directly — local
// fs for shared, over SSM for dedicated/EC2. Each function is a directory <slug>/ holding its
// files plus an optional .metadata.json (name/verify_jwt/version/timestamps). The internal
// `main` router dir is hidden. EC2-safe: deploy/delete push to the on-box volume over SSM and
// the runtime picks them up per request (no restart); list/read are bounded by SSM's ~24KB
// output, fine for typical functions.

const META_FILE = ".metadata.json";
const EC2_FN_BASE = "/opt/supabase/docker/volumes/functions";

export interface FunctionFile {
  name: string;
  content: string;
}
export interface FunctionMeta {
  id: string;
  slug: string;
  name: string;
  status: "ACTIVE";
  version: number;
  verify_jwt: boolean;
  entrypoint_path: string;
  import_map_path: string | null;
  import_map: boolean;
  created_at: number;
  updated_at: number;
}

// A function slug becomes a path segment + a shell arg, so lock it down hard.
function assertSlug(slug: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(slug) || slug === "main") {
    throw new AppError(400, "invalid_slug", "Function slug must be 1-64 chars of [a-z0-9_-] and not 'main'");
  }
}

// A file path within a function dir. Allow nested paths but block traversal AND every shell
// metacharacter — on EC2 this name is interpolated into an SSM shell command, so a name like
// `$(...)` or with backticks/semicolons would otherwise execute on the instance.
function assertFileName(name: string): void {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 255 ||
    name.includes("..") ||
    name.startsWith("/") ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9._/-]*$/.test(name)
  ) {
    throw new AppError(400, "invalid_file", `Invalid file name: ${name}`);
  }
}

function buildMeta(slug: string, m: Partial<FunctionMeta>, fallbackTs: number): FunctionMeta {
  return {
    id: m.id ?? slug,
    slug,
    name: m.name ?? slug,
    status: "ACTIVE",
    version: m.version ?? 1,
    verify_jwt: m.verify_jwt ?? true,
    entrypoint_path: m.entrypoint_path ?? "index.ts",
    import_map_path: m.import_map_path ?? null,
    import_map: !!m.import_map_path,
    created_at: m.created_at ?? fallbackTs,
    updated_at: m.updated_at ?? fallbackTs,
  };
}

function isShared(p: Project): boolean {
  return p.infrastructureType === "shared";
}
// Dedicated-instance writes go over SSM, which requires the instance to be running.
function assertInstanceRunning(p: Project): void {
  if (p.status !== "active") {
    throw new AppError(
      409,
      "project_not_running",
      `Project is ${p.status} — resume it before modifying edge functions on a dedicated instance`
    );
  }
}
function sharedBase(p: Project): string {
  return join(projectDir(p.ref), "volumes", "functions");
}
function ec2InstanceId(p: Project): string {
  const id = (p.connection as { instanceId?: string } | null)?.instanceId;
  if (!id) throw new AppError(400, "no_instance", `Project ${p.ref} has no running instance`);
  return id;
}
async function ec2Ssm(p: Project): Promise<SSMClient> {
  const creds = await getCredentials(p.organizationId);
  return new SSMClient({
    region: p.region ?? "us-east-1",
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
  });
}
async function ssm(p: Project, script: string): Promise<string> {
  const client = await ec2Ssm(p);
  return runCommand(client, ec2InstanceId(p), script);
}
function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/** List the project's functions (excludes the internal `main` router). */
export async function listFunctions(p: Project): Promise<FunctionMeta[]> {
  if (isShared(p)) {
    const base = sharedBase(p);
    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    const out: FunctionMeta[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "main") continue;
      const dir = join(base, e.name);
      let meta: Partial<FunctionMeta> = {};
      try {
        meta = JSON.parse(await readFile(join(dir, META_FILE), "utf8"));
      } catch {
        /* infer */
      }
      const st = await stat(dir).catch(() => null);
      out.push(buildMeta(e.name, meta, st ? Math.floor(st.mtimeMs) : Date.now()));
    }
    return out;
  }
  // EC2: list dirs + their metadata in one SSM round-trip.
  const script =
    `cd ${EC2_FN_BASE} 2>/dev/null || exit 0\n` +
    `for d in */; do slug="\${d%/}"; [ "$slug" = main ] && continue; ` +
    `echo "===SLUG:$slug==="; cat "$slug/${META_FILE}" 2>/dev/null || echo "{}"; done`;
  const out = await ssm(p, script).catch(() => "");
  const metas: FunctionMeta[] = [];
  for (const block of out.split("===SLUG:").slice(1)) {
    const nl = block.indexOf("===");
    const slug = block.slice(0, nl).trim();
    const json = block.slice(nl + 3).trim();
    let meta: Partial<FunctionMeta> = {};
    try {
      meta = JSON.parse(json);
    } catch {
      /* infer */
    }
    if (slug) metas.push(buildMeta(slug, meta, Date.now()));
  }
  return metas;
}

/** A single function's metadata (null if it doesn't exist). */
export async function getFunction(p: Project, slug: string): Promise<FunctionMeta | null> {
  assertSlug(slug);
  return (await listFunctions(p)).find((f) => f.slug === slug) ?? null;
}

/** A function's source files (excludes .metadata.json). */
export async function getFunctionFiles(p: Project, slug: string): Promise<FunctionFile[]> {
  assertSlug(slug);
  if (isShared(p)) {
    const dir = join(sharedBase(p), slug);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return [];
    const files: FunctionFile[] = [];
    for (const e of entries) {
      if (!e.isFile() || e.name === META_FILE) continue;
      files.push({ name: e.name, content: await readFile(join(dir, e.name), "utf8") });
    }
    return files;
  }
  const script =
    `cd ${EC2_FN_BASE}/${slug} 2>/dev/null || exit 0\n` +
    `for f in $(ls -A); do [ "$f" = "${META_FILE}" ] && continue; [ -f "$f" ] || continue; ` +
    `echo "===FILE:$f==="; base64 -w0 "$f"; echo ""; done`;
  const out = await ssm(p, script).catch(() => "");
  const files: FunctionFile[] = [];
  for (const block of out.split("===FILE:").slice(1)) {
    const nl = block.indexOf("===");
    const name = block.slice(0, nl).trim();
    const content = Buffer.from(block.slice(nl + 3).trim(), "base64").toString("utf8");
    if (name) files.push({ name, content });
  }
  return files;
}

/** Deploy (create or overwrite) a function: write its files + metadata to the volume. */
export async function deployFunction(
  p: Project,
  slug: string,
  files: FunctionFile[],
  metadata: Partial<FunctionMeta>
): Promise<FunctionMeta> {
  assertSlug(slug);
  if (!Array.isArray(files) || files.length === 0) {
    throw new AppError(400, "no_files", "At least one file is required");
  }
  // sanitise every file (strict name allowlist — blocks traversal + shell injection on EC2)
  for (const f of files) {
    if (!f || typeof f.content !== "string") throw new AppError(400, "invalid_file", "Invalid file entry");
    assertFileName(f.name);
  }

  const existing = await getFunction(p, slug);
  const now = Date.now();
  const meta = buildMeta(slug, {
    ...metadata,
    name: metadata.name ?? existing?.name ?? slug,
    version: (existing?.version ?? 0) + 1,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  }, now);

  if (isShared(p)) {
    const dir = join(sharedBase(p), slug);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    for (const f of files) {
      const dest = join(dir, f.name);
      await mkdir(dirname(dest), { recursive: true }); // support nested files (e.g. _shared/x.ts)
      await writeFile(dest, f.content, "utf8");
    }
    await writeFile(join(dir, META_FILE), JSON.stringify(meta), "utf8");
    return meta;
  }
  // EC2 writes go over SSM, which needs the instance RUNNING — fail with a clear message
  // instead of SSM's cryptic InvalidInstanceId when the project is paused/stopped.
  assertInstanceRunning(p);
  // EC2: rewrite the function dir over SSM (base64 each file to survive the shell; names are
  // allowlist-validated above so interpolating them into the path can't inject).
  const writes = [
    `rm -rf "${EC2_FN_BASE}/${slug}"`,
    `mkdir -p "${EC2_FN_BASE}/${slug}"`,
    ...files.flatMap((f) => {
      const path = `${EC2_FN_BASE}/${slug}/${f.name}`;
      return [`mkdir -p "$(dirname "${path}")"`, `echo ${b64(f.content)} | base64 -d > "${path}"`];
    }),
    `echo ${b64(JSON.stringify(meta))} | base64 -d > "${EC2_FN_BASE}/${slug}/${META_FILE}"`,
  ].join("\n");
  await ssm(p, writes);
  return meta;
}

/** Delete a function (removes its volume directory). */
export async function deleteFunction(p: Project, slug: string): Promise<void> {
  assertSlug(slug);
  if (isShared(p)) {
    await rm(join(sharedBase(p), slug), { recursive: true, force: true });
    return;
  }
  assertInstanceRunning(p);
  await ssm(p, `rm -rf ${EC2_FN_BASE}/${slug}`);
}
