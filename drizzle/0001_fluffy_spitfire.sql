ALTER TABLE "import_batches" ADD COLUMN "created_by_email" varchar;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "commit_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "commit_started_by" varchar;