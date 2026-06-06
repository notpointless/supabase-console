import type { Project } from "../db/schema";
import { SharedInfraProvisioner } from "./shared-infra-provisioner";

export interface Connection {
  host: string;
  apiUrl?: string;
  kongHttpPort?: number;
  kongHttpsPort?: number;
  dbPort?: number;
  port?: number;
  ref?: string;
}

export interface ProvisionResult {
  connection: Connection;
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
let overridden = false;

export function getProvisioner(): Provisioner {
  if (!current) current = new StubProvisioner();
  return current;
}
export function setProvisioner(p: Provisioner): void {
  current = p;
  overridden = true;
}
export function resetProvisioner(): void {
  current = undefined;
  overridden = false;
}

export function getProvisionerFor(project: { infrastructureType: string }): Provisioner {
  if (overridden) return getProvisioner();
  return project.infrastructureType === "shared" ? new SharedInfraProvisioner() : new StubProvisioner();
}
