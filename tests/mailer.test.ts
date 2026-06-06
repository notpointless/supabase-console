import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock nodemailer before importing SmtpMailer.
const sendMail = vi.fn().mockResolvedValue({ messageId: "1" });
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail }) },
  createTransport: () => ({ sendMail }),
}));

import { SmtpMailer } from "../src/email/smtp-mailer";
import { LogMailer } from "../src/email/log-mailer";

const invite = {
  to: "invitee@example.com",
  acceptUrl: "http://localhost:3000/accept-invite?invitationId=inv1",
  organizationName: "Acme",
  role: "developer",
  inviterEmail: "owner@example.com",
};

describe("mailer", () => {
  beforeEach(() => sendMail.mockClear());

  it("SmtpMailer sends via nodemailer with from/to/subject and the accept url in the body", async () => {
    const mailer = new SmtpMailer("smtp://localhost:1025", "Console <no-reply@example.com>");
    await mailer.sendInvite(invite);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const arg = sendMail.mock.calls[0]![0]!;
    expect(arg.from).toBe("Console <no-reply@example.com>");
    expect(arg.to).toBe("invitee@example.com");
    expect(arg.subject).toContain("Acme");
    expect(`${arg.text} ${arg.html}`).toContain(invite.acceptUrl);
  });

  it("LogMailer does not throw", async () => {
    await expect(new LogMailer().sendInvite(invite)).resolves.toBeUndefined();
  });
});
