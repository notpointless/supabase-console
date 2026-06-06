CREATE TABLE "org_aws_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"access_key_id" text NOT NULL,
	"secret_access_key_encrypted" text NOT NULL,
	"default_region" text NOT NULL,
	"aws_account_id" text,
	"validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_aws_credentials_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"region" text NOT NULL,
	"infrastructure_type" text NOT NULL,
	"postgres_type" text DEFAULT 'postgres' NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"data_api_enabled" boolean DEFAULT true NOT NULL,
	"auto_expose_new_tables" boolean DEFAULT true NOT NULL,
	"auto_enable_rls" boolean DEFAULT true NOT NULL,
	"db_password_encrypted" text NOT NULL,
	"connection" jsonb,
	"failure_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_ref_unique" UNIQUE("ref")
);
--> statement-breakpoint
ALTER TABLE "org_aws_credentials" ADD CONSTRAINT "org_aws_credentials_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;