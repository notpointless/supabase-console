import nodemailer, { type Transporter } from "nodemailer";
import type { Mailer, InviteEmail } from "./mailer.js";

export class SmtpMailer implements Mailer {
  private transport: Transporter;

  constructor(smtpUrl: string, private readonly from: string) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async sendInvite(email: InviteEmail): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: email.to,
      subject: `You've been invited to ${email.organizationName}`,
      text: `You've been invited to join ${email.organizationName} as ${email.role}. Accept your invitation: ${email.acceptUrl}`,
      html: `<p>You've been invited to join <strong>${email.organizationName}</strong> as ${email.role}.</p><p><a href="${email.acceptUrl}">Accept invitation</a></p>`,
    });
  }
}
