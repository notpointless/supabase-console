import type { Project } from "../db/schema";
import { SharedInfraProvisioner } from "./shared-infra-provisioner";
import { Ec2Provisioner } from "./ec2-provisioner";

export interface Connection {
  host: string;
  apiUrl?: string;
  kongHttpPort?: number;
  kongHttpsPort?: number;
  dbPort?: number;
  port?: number;
  ref?: string;
  // Dedicated (EC2) projects record their instance + region for lifecycle ops.
  instanceId?: string;
  region?: string;
}

export interface ProvisionResult {
  connection: Connection;
}

export interface Provisioner {
  provision(project: Project): Promise<ProvisionResult>;
  pause(project: Project): Promise<void>;
  resume(project: Project): Promise<void>;
  delete(project: Project): Promise<void>;
  // Re-apply stack config (e.g. Data API on/off) in place, preserving ports.
  reconfigure?(project: Project): Promise<void>;
  // Restart the project's services. `services` (mapped compose service names) is a
  // best-effort hint; infra that can only restart the whole stack/instance ignores it.
  restart?(project: Project, services?: string[]): Promise<void>;
  // Change the project's compute (dedicated only): stop, switch to the instance type
  // for project.computeSize, start. Returns the (new) connection to persist.
  resize?(project: Project): Promise<Connection>;
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
  if (project.infrastructureType === "shared") return new SharedInfraProvisioner();
  // dedicated_ec2 -> a real EC2 server running the self-hosting stack, not a container.
  return new Ec2Provisioner();
}
