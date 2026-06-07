CREATE TABLE "github_authorization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"github_user_id" integer NOT NULL,
	"github_login" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_authorization_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "github_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"installation_id" integer NOT NULL,
	"repository_id" integer NOT NULL,
	"repository_name" text NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"workdir" text DEFAULT '.' NOT NULL,
	"new_branch_per_pr" boolean DEFAULT true NOT NULL,
	"supabase_changes_only" boolean DEFAULT true NOT NULL,
	"branch_limit" integer DEFAULT 3 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_connection_project_uniq" UNIQUE("project_id")
);
--> statement-breakpoint
ALTER TABLE "github_authorization" ADD CONSTRAINT "github_authorization_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_connection" ADD CONSTRAINT "github_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_connection" ADD CONSTRAINT "github_connection_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_connection" ADD CONSTRAINT "github_connection_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;