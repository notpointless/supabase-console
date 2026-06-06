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
    const { composeYaml, env } = buildStack({
      project: { ref: project.ref, name: project.name },
      secrets,
      dbPassword: decrypt(project.dbPasswordEncrypted),
      ports: { kongHttp: ports.kongHttpPort, kongHttps: ports.kongHttpsPort, db: ports.dbPort },
      urls: { apiExternalUrl: apiUrl, siteUrl: apiUrl, supabasePublicUrl: apiUrl },
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

  async pause(project: Project): Promise<void> {
    await getComposeRunner().stop(projectDir(project.ref), name(project.ref));
  }

  async resume(project: Project): Promise<void> {
    await getComposeRunner().start(projectDir(project.ref), name(project.ref));
  }

  async delete(project: Project): Promise<void> {
    await getComposeRunner().down(projectDir(project.ref), name(project.ref));
    removeStack(project.ref);
  }
}
