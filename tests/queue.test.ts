import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { project, organization, user } from "../src/db/schema";
import { InlineQueue } from "../src/jobs/queue";
import { resetProvisioner, setProvisioner } from "../src/projects/provisioner";
import { encrypt } from "../src/crypto/secrets";

async function seed(): Promise<{ ref: string }> {
  const uid = "u_" + Math.random().toString(36).slice(2, 10);
  const oid = "o_" + Math.random().toString(36).slice(2, 10);
  await db.insert(user).values({ id: uid, name: "U", email: `${uid}@x.com`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } as never);
  await db.insert(organization).values({ id: oid, name: "Org", slug: oid, createdAt: new Date() } as never);
  const ref = "p_" + Math.random().toString(36).slice(2, 10);
  await db.insert(project).values({
    ref, organizationId: oid, name: "P", region: "shared", infrastructureType: "shared",
    dbPasswordEncrypted: encrypt("pw"), createdBy: uid,
  } as never);
  return { ref };
}

describe("InlineQueue + provision task", () => {
  afterEach(() => resetProvisioner());

  it("provision flips project to active with a connection", async () => {
    const { ref } = await seed();
    await new InlineQueue().enqueue("provision", { ref });
    const [row] = await db.select().from(project).where(eq(project.ref, ref));
    expect(row!.status).toBe("active");
    expect((row!.connection as { ref: string }).ref).toBe(ref);
  });

  it("provision failure marks the project failed", async () => {
    const { ref } = await seed();
    setProvisioner({ provision: async () => { throw new Error("boom"); }, pause: async () => {}, resume: async () => {}, delete: async () => {} });
    await new InlineQueue().enqueue("provision", { ref });
    const [row] = await db.select().from(project).where(eq(project.ref, ref));
    expect(row!.status).toBe("failed");
    expect(row!.failureReason).toContain("boom");
  });
});
