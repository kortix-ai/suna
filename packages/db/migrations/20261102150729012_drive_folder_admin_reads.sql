-- Migration: drive_folder_admin_reads
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- A project admin may open another person's own folder (`/Users/<name>`) in
-- the Drive; each open is recorded so the owner sees it. The table is new and
-- empty: its primary key builds on no rows. The FK to kortix.drives takes a
-- brief SHARE ROW EXCLUSIVE lock on drives (bounded by lock_timeout) and checks
-- no rows. RLS is on with no policy: only the API (owner role) reads it.

CREATE TABLE "kortix"."drive_folder_admin_reads" (
	"drive_id" uuid NOT NULL,
	"folder" text NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opens" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "drive_folder_admin_reads_drive_id_folder_admin_user_id_day_pk" PRIMARY KEY("drive_id","folder","admin_user_id","day")
);
--> statement-breakpoint
-- squawk-ignore adding-foreign-key-constraint, constraint-missing-not-valid
ALTER TABLE "kortix"."drive_folder_admin_reads" ADD CONSTRAINT "drive_folder_admin_reads_drive_id_drives_drive_id_fk" FOREIGN KEY ("drive_id") REFERENCES "kortix"."drives"("drive_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."drive_folder_admin_reads" ENABLE ROW LEVEL SECURITY;
