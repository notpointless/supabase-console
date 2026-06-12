import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { project, organization, user } from "../src/db/schema";
import { InlineQueue } from "../src/jobs/queue";
import { resetProvisioner, setProvisioner, StubProvisioner } from "../src/projects/provisioner";
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
  beforeEach(() => { resetProvisioner(); setProvisioner(new StubProvisioner()); });
  afterEach(() => resetProvisioner());

  it("provision flips project to active with a connection", async () => {
    const { ref } = await seed();
    await new InlineQueue().enqueue("provision", { ref });
    const [row] = await db.select().from(project).where(eq(project.ref, ref));
    expect(row!.status).toBe("active");
    expect((row!.connection as { ref: string }).ref).toBe(ref);
  });

  it("provision failure rolls back — the project row is removed", async () => {
    // A failed provision must not leave a half-provisioned project behind: the task tears
    // down any partial resources (delete) and removes the row entirely.
    const { ref } = await seed();
    let deleteCalled = false;
    setProvisioner({
      provision: async () => { throw new Error("boom"); },
      pause: async () => {},
      resume: async () => {},
      delete: async () => { deleteCalled = true; },
    });
    await new InlineQueue().enqueue("provision", { ref });
    const [row] = await db.select().from(project).where(eq(project.ref, ref));
    expect(row).toBeUndefined();
    expect(deleteCalled).toBe(true);
  });
});
