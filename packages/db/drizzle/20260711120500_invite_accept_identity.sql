ALTER TABLE "kortix"."account_invitations"
ADD COLUMN IF NOT EXISTS "accepted_by_user_id" uuid;
