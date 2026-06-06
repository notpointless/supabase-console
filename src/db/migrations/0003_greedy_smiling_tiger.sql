CREATE TABLE "project_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"jwt_secret_encrypted" text NOT NULL,
	"anon_key_encrypted" text NOT NULL,
	"service_role_key_encrypted" text NOT NULL,
	"secret_key_base_encrypted" text NOT NULL,
	"dashboard_password_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_secrets_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
ALTER TABLE "project_secrets" ADD CONSTRAINT "project_secrets_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;