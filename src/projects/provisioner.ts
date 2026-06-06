import type { Project } from "../db/schema";

export interface ProvisionResult {
  connection: { host: string; port: number; ref: string };
}

export interface Provisioner {
  provision(project: Project): Promise<ProvisionResult>;
  pause(project: Project): Promise<void>;
  resume(project: Project): Promise<void>;
  delete(project: Project): Promise<void>;
}

// Phase-2 stand-in for the real engine (Phase 3 replaces this).
export class StubProvisioner implements Provisioner {
  async provision(project: Project): Promise<ProvisionResult> {
    return { connection: { host: `db.${project.ref}.stub.local`, port: 5432, ref: project.ref } };
  }
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async delete(): Promise<void> {}
}

let current: Provisioner | undefined;

export function getProvisioner(): Provisioner {
  if (!current) current = new StubProvisioner();
  return current;
}
export function setProvisioner(p: Provisioner): void {
  current = p;
}
export function resetProvisioner(): void {
  current = undefined;
}
