import type { Provisioner, ProvisionResult } from "./provisioner";
import type { Project } from "../db/schema";
import { getProjectSecrets } from "./secrets";
import { decrypt } from "../crypto/secrets";
import { allocatePorts } from "./ports";
import { buildStack } from "./stack/compose";
import { writeStack, removeStack, projectDir } from "./stack/writer";
import { getComposeRunner } from "./stack/compose-runner";
import { getEnv } from "../config/env";

function name(ref: string): string {
  return `sb-${ref}`;
}

export class SharedInfraProvisioner implements Provisioner {
  async provision(project: Project): Promise<ProvisionResult> {
    const secrets = await getProjectSecrets(project.id);
    if (!secrets) throw new Error(`No secrets for project ${project.ref}`);
    const ports = await allocatePorts(project.id);
    const host = getEnv().PUBLIC_HOST;
    const apiUrl = `http://${host}:${ports.kongHttpPort}`;
    const { composeYaml, env } = await buildStack({
      project: { ref: project.ref, name: project.name },
      secrets,
      dbPassword: decrypt(project.dbPasswordEncrypted),
      ports: { kongHttp: ports.kongHttpPort, kongHttps: ports.kongHttpsPort, db: ports.dbPort },
      urls: { apiExternalUrl: apiUrl, siteUrl: apiUrl, supabasePublicUrl: apiUrl },
      dataApiEnabled: project.dataApiEnabled,
      authConfig: project.authConfig as Record<string, unknown> | null,
    });
    const dir = writeStack(project.ref, { composeYaml, env });
    await getComposeRunner().up(dir, name(project.ref));
    return {
      connection: {
        host,
        apiUrl,
        kongHttpPort: ports.kongHttpPort,
        kongHttpsPort: ports.kongHttpsPort,
        dbPort: ports.dbPort,
      },
    };
  }

  // [console fork] Re-apply the stack env (e.g. Data API on/off) WITHOUT
  // reallocating ports — reuses the project's already-assigned ports so the
  // running connection is preserved, then recreates changed containers.
  async reconfigure(project: Project): Promise<void> {
    const secrets = await getProjectSecrets(project.id);
    if (!secrets) throw new Error(`No secrets for project ${project.ref}`);
    if (project.kongHttpPort == null || project.kongHttpsPort == null || project.dbPort == null) {
      // never provisioned with stored ports — fall back to a full provision
      await this.provision(project);
      return;
    }
    const host = getEnv().PUBLIC_HOST;
    const apiUrl = `http://${host}:${project.kongHttpPort}`;
    const { composeYaml, env } = await buildStack({
      project: { ref: project.ref, name: project.name },
      secrets,
      dbPassword: decrypt(project.dbPasswordEncrypted),
      ports: { kongHttp: project.kongHttpPort, kongHttps: project.kongHttpsPort, db: project.dbPort },
      urls: { apiExternalUrl: apiUrl, siteUrl: apiUrl, supabasePublicUrl: apiUrl },
      dataApiEnabled: project.dataApiEnabled,
      authConfig: project.authConfig as Record<string, unknown> | null,
    });
    const dir = writeStack(project.ref, { composeYaml, env });
    await getComposeRunner().up(dir, name(project.ref));
  }

  async pause(project: Project): Promise<void> {
    await getComposeRunner().stop(projectDir(project.ref), name(project.ref));
  }

  async resume(project: Project): Promise<void> {
    await getComposeRunner().start(projectDir(project.ref), name(project.ref));
  }

  async restart(project: Project, _services?: string[]): Promise<void> {
    // [console fork] Regenerate the stack from the current templates + secrets and recreate
    // changed containers, so a restart actually applies config/provisioning fixes (e.g. an
    // updated GOTRUE_JWT_KEYS) instead of bouncing the old containers with stale env.
    await this.reconfigure(project);
  }

  async delete(project: Project): Promise<void> {
    await getComposeRunner().down(projectDir(project.ref), name(project.ref));
    removeStack(project.ref);
  }
}
