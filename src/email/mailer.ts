import { getEnv } from "../config/env.js";
import { SmtpMailer } from "./smtp-mailer.js";
import { LogMailer } from "./log-mailer.js";

export interface InviteEmail {
  to: string;
  acceptUrl: string;
  organizationName: string;
  role: string;
  inviterEmail?: string;
}

export interface Mailer {
  sendInvite(email: InviteEmail): Promise<void>;
}

let current: Mailer | undefined;

export function getMailer(): Mailer {
  if (!current) {
    const env = getEnv();
    if (env.SMTP_URL) {
      current = new SmtpMailer(
        env.SMTP_URL,
        env.MAIL_FROM ?? "Supabase Console <no-reply@example.com>",
      );
    } else {
      current = new LogMailer();
    }
  }
  return current;
}

export function setMailer(mailer: Mailer): void {
  current = mailer;
}

export function resetMailer(): void {
  current = undefined;
}
