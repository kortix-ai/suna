CREATE TABLE "kortix"."user_model_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"default_model" text,
	"hidden_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
