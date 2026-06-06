ALTER TABLE "organization" ADD COLUMN "type" text DEFAULT 'personal';--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "data_privacy_level" text DEFAULT 'disabled';