CREATE TABLE "org_github_app_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"app_name" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_github_app_config_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
ALTER TABLE "github_authorization" DROP CONSTRAINT "github_authorization_user_id_unique";--> statement-breakpoint
ALTER TABLE "github_authorization" ADD COLUMN "organization_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "org_github_app_config" ADD CONSTRAINT "org_github_app_config_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_authorization" ADD CONSTRAINT "github_authorization_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_authorization" ADD CONSTRAINT "github_authorization_user_org_uniq" UNIQUE("user_id","organization_id");