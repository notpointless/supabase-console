import type { Mailer, InviteEmail } from "./mailer.js";

export class LogMailer implements Mailer {
  async sendInvite(email: InviteEmail): Promise<void> {
    console.log(
      `[invite] to=${email.to} org=${email.organizationName} role=${email.role} accept=${email.acceptUrl}`,
    );
  }
}
