import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { project, organization, user } from "../src/db/schema";
import { encrypt } from "../src/crypto/secrets";
import { generateProjectSecrets, storeProjectSecrets } from "../src/projects/secrets";
import { SharedInfraProvisioner } from "../src/projects/shared-infra-provisioner";
import { setComposeRunner, resetComposeRunner } from "../src/projects/stack/compose-runner";
import { projectDir } from "../src/projects/stack/writer";

async function seed(): Promise<typeof project.$inferSelect> {
  const uid = "u_" + Math.random().toString(36).slice(2, 10);
  const oid = "o_" + Math.random().toString(36).slice(2, 10);
  await db.insert(user).values({ id: uid, name: "U", email: `${uid}@x.com`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } as never);
  await db.insert(organization).values({ id: oid, name: "Org", slug: oid, createdAt: new Date() } as never);
  const ref = "pr" + Math.random().toString(36).slice(2, 8);
  const [row] = await db.insert(project).values({ ref, organizationId: oid, name: "P", region: "shared", infrastructureType: "shared", dbPasswordEncrypted: encrypt("dbpw"), createdBy: uid } as never).returning();
  await storeProjectSecrets(row!.id, await generateProjectSecrets());
  return row!;
}

describe("SharedInfraProvisioner", () => {
  afterEach(() => resetComposeRunner());

  it("provision writes stack, allocates ports, calls up, returns secret-free connection", async () => {
    const calls: string[] = [];
    setComposeRunner({ up: async () => { calls.push("up"); }, stop: async () => {}, start: async () => {}, down: async () => {}, restart: async () => {} });
    const row = await seed();
    const res = await new SharedInfraProvisioner().provision(row);
    expect(calls).toEqual(["up"]);
    const conn = res.connection as unknown as Record<string, unknown>;
    expect(conn.apiUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(JSON.stringify(conn)).not.toMatch(/jwt|service_role|password/i);
    const [updated] = await db.select().from(project).where(eq(project.id, row.id));
    expect(updated!.kongHttpPort).toBeGreaterThanOrEqual(20000);
    rmSync(projectDir(row.ref), { recursive: true, force: true });
  });

  it("propagates up() failure", async () => {
    setComposeRunner({ up: async () => { throw new Error("docker boom"); }, stop: async () => {}, start: async () => {}, down: async () => {}, restart: async () => {} });
    const row = await seed();
    await expect(new SharedInfraProvisioner().provision(row)).rejects.toThrow(/boom/);
    rmSync(projectDir(row.ref), { recursive: true, force: true });
  });

  it("delete calls down and removes the dir", async () => {
    const calls: string[] = [];
    setComposeRunner({ up: async () => {}, stop: async () => {}, start: async () => {}, down: async () => { calls.push("down"); }, restart: async () => {} });
    const row = await seed();
    await new SharedInfraProvisioner().provision(row);
    await new SharedInfraProvisioner().delete(row);
    expect(calls).toEqual(["down"]);
  });
});
