ALTER TABLE "kortix"."chat_channel_bindings" ALTER COLUMN "channel_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "kortix"."chat_threads" ALTER COLUMN "thread_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "kortix"."chat_thread_participants" ALTER COLUMN "thread_id" SET DATA TYPE text;
