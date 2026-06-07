ALTER TABLE "project" ADD COLUMN "parent_project_id" uuid;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "git_branch" text;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_parent_project_id_project_id_fk" FOREIGN KEY ("parent_project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;