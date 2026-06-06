ALTER TABLE "project" ADD COLUMN "kong_http_port" integer;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "kong_https_port" integer;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "db_port" integer;