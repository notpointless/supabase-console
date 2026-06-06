CREATE TABLE "project_privatelink_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"aws_account_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_privatelink_account_project_id_aws_account_id_uniq" UNIQUE("project_id","aws_account_id")
);
--> statement-breakpoint
ALTER TABLE "project_privatelink_account" ADD CONSTRAINT "project_privatelink_account_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;