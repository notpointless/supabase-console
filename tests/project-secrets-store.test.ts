import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { project, organization, user, projectSecrets } from "../src/db/schema";
import { generateProjectSecrets, storeProjectSecrets, getProjectSecrets } from "../src/projects/secrets";
import { encrypt } from "../src/crypto/secrets";

async function seedProject(): Promise<string> {
  const uid = "u_" + Math.random().toString(36).slice(2, 10);
  const oid = "o_" + Math.random().toString(36).slice(2, 10);
  await db.insert(user).values({ id: uid, name: "U", email: `${uid}@x.com`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } as never);
  await db.insert(organization).values({ id: oid, name: "Org", slug: oid, createdAt: new Date() } as never);
  const ref = "p_" + Math.random().toString(36).slice(2, 10);
  const [row] = await db.insert(project).values({
    ref, organizationId: oid, name: "P", region: "shared", infrastructureType: "shared",
    dbPasswordEncrypted: encrypt("pw"), createdBy: uid,
  } as never).returning();
  return row!.id;
}

describe("project secrets storage", () => {
  it("stores encrypted and round-trips via getProjectSecrets", async () => {
    const projectId = await seedProject();
    const values = await generateProjectSecrets();
    await storeProjectSecrets(projectId, values);

    const [raw] = await db.select().from(projectSecrets).where(eq(projectSecrets.projectId, projectId));
    expect(raw!.jwtSecretEncrypted).not.toBe(values.jwtSecret);
    expect(raw!.serviceRoleKeyEncrypted).not.toContain(values.serviceRoleKey);

    const got = await getProjectSecrets(projectId);
    expect(got).toEqual(values);
  });

  it("returns undefined for a project with no secrets", async () => {
    const projectId = await seedProject();
    expect(await getProjectSecrets(projectId)).toBeUndefined();
  });
});
