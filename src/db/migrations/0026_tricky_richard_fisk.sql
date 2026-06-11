CREATE TABLE "project_edge_function" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"verify_jwt" boolean DEFAULT true NOT NULL,
	"entrypoint_path" text,
	"import_map_path" text,
	"version" integer DEFAULT 1 NOT NULL,
	"files" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_edge_function_project_id_slug_uniq" UNIQUE("project_id","slug")
);
--> statement-breakpoint
ALTER TABLE "project_edge_function" ADD CONSTRAINT "project_edge_function_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;