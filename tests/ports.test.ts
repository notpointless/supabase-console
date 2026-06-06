import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { project, organization, user } from "../src/db/schema";
import { encrypt } from "../src/crypto/secrets";
import { allocatePorts } from "../src/projects/ports";

async function seedProject(): Promise<string> {
  const uid = "u_" + Math.random().toString(36).slice(2, 10);
  const oid = "o_" + Math.random().toString(36).slice(2, 10);
  await db.insert(user).values({ id: uid, name: "U", email: `${uid}@x.com`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } as never);
  await db.insert(organization).values({ id: oid, name: "Org", slug: oid, createdAt: new Date() } as never);
  const ref = "p_" + Math.random().toString(36).slice(2, 10);
  const [row] = await db.insert(project).values({ ref, organizationId: oid, name: "P", region: "shared", infrastructureType: "shared", dbPasswordEncrypted: encrypt("pw"), createdBy: uid } as never).returning();
  return row!.id;
}

describe("port allocator", () => {
  it("allocates distinct non-overlapping triples and persists them", async () => {
    const a = await allocatePorts(await seedProject());
    const b = await allocatePorts(await seedProject());
    for (const p of [a, b]) {
      expect(p.kongHttpPort).toBeGreaterThanOrEqual(20000);
      expect(p.kongHttpsPort).toBe(p.kongHttpPort + 1);
      expect(p.dbPort).toBe(p.kongHttpPort + 2);
    }
    const all = [a.kongHttpPort, a.kongHttpsPort, a.dbPort, b.kongHttpPort, b.kongHttpsPort, b.dbPort];
    expect(new Set(all).size).toBe(6);
  });

  it("persists ports on the project row", async () => {
    const id = await seedProject();
    const p = await allocatePorts(id);
    const [row] = await db.select().from(project).where(eq(project.id, id));
    expect(row!.kongHttpPort).toBe(p.kongHttpPort);
    expect(row!.dbPort).toBe(p.dbPort);
  });
});
