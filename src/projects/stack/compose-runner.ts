import { spawn } from "node:child_process";
import { posix as path } from "node:path";

export interface ComposeRunner {
  up(dir: string, project: string): Promise<void>;
  stop(dir: string, project: string): Promise<void>;
  start(dir: string, project: string): Promise<void>;
  down(dir: string, project: string): Promise<void>;
  restart(dir: string, project: string, services?: string[]): Promise<void>;
  // Force-recreate specific services (optional; degrades to a no-op on mocks that omit it).
  recreate?(dir: string, project: string, services: string[]): Promise<void>;
}

export type Exec = (cmd: string, args: string[]) => Promise<void>;

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    // Capture output via pipes instead of inheriting the parent's stdio. The control
    // plane often runs without a console (background / detached / service). Inheriting
    // absent console handles makes Windows fail console apps like `docker` at startup
    // with STATUS_DLL_INIT_FAILED (exit 3221225794 / 0xC0000142) — which silently broke
    // shared-stack teardown. Piping gives the child its own handles and surfaces stderr.
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (d) => (output += d.toString()));
    child.stderr?.on("data", (d) => (output += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}${output ? `: ${output.trim().slice(-300)}` : ""}`))
    );
  });

export class DockerComposeRunner implements ComposeRunner {
  constructor(private readonly exec: Exec = defaultExec) {}
  private base(dir: string, project: string): string[] {
    return ["compose", "-p", project, "-f", path.join(dir, "compose.yaml"), "--env-file", path.join(dir, ".env")];
  }
  up(dir: string, project: string) { return this.exec("docker", [...this.base(dir, project), "up", "-d"]); }
  stop(dir: string, project: string) { return this.exec("docker", [...this.base(dir, project), "stop"]); }
  start(dir: string, project: string) { return this.exec("docker", [...this.base(dir, project), "start"]); }
  down(dir: string, project: string) { return this.exec("docker", [...this.base(dir, project), "down", "-v"]); }
  restart(dir: string, project: string, services: string[] = []) {
    return this.exec("docker", [...this.base(dir, project), "restart", ...services]);
  }
  recreate(dir: string, project: string, services: string[]) {
    return this.exec("docker", [...this.base(dir, project), "up", "-d", "--force-recreate", "--no-deps", ...services]);
  }
}

let current: ComposeRunner | undefined;
export function getComposeRunner(): ComposeRunner { if (!current) current = new DockerComposeRunner(); return current; }
export function setComposeRunner(r: ComposeRunner): void { current = r; }
export function resetComposeRunner(): void { current = undefined; }
