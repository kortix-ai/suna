-- Allow function bodies to reference objects created later (pg_dump preamble).
SET check_function_bodies = false;
--> statement-breakpoint
-- 0000_bootstrap — non-kortix baseline curated from prod (2026-06-05).
-- basejump (account framework + auth.users signup trigger), public credit
-- RPC functions, signup helpers, welcome webhook, storage buckets. kortix.*
-- is generated in 0001. Assumes a fresh Supabase stack (auth, storage, roles).

create extension if not exists pgcrypto;
--> statement-breakpoint
create extension if not exists pg_net;
--> statement-breakpoint
create extension if not exists pg_trgm with schema public;
--> statement-breakpoint
-- public signup-chain helpers (auth email reader + EXCEPTION-guarded credit init)
CREATE OR REPLACE FUNCTION public.get_user_email(user_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    user_email TEXT;
BEGIN
    SELECT email INTO user_email
    FROM auth.users
    WHERE id = user_id;
    
    IF user_email IS NULL THEN
        SELECT 
            COALESCE(
                raw_user_meta_data->>'email',
                raw_user_meta_data->>'user_email',
                email
            ) INTO user_email
        FROM auth.users
        WHERE id = user_id;
    END IF;
    
    RETURN user_email;
END;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.initialize_free_tier_credits()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    IF NEW.personal_account = TRUE THEN
        INSERT INTO public.credit_accounts (
            account_id,
            balance,
            tier,
            trial_status,
            last_grant_date
        ) VALUES (
            NEW.id,
            0.00,
            'none',
            'none',
            NOW()
        )
        ON CONFLICT (account_id) DO NOTHING;
        RAISE LOG 'Created account for new user % - will auto-subscribe to free tier via Stripe', NEW.id;
    END IF;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Error in initialize_free_tier_credits for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$function$
;
--> statement-breakpoint
-- basejump: account framework + run_new_user_setup
CREATE SCHEMA IF NOT EXISTS "basejump";
--> statement-breakpoint
ALTER SCHEMA "basejump" OWNER TO "postgres";
--> statement-breakpoint
CREATE TYPE "basejump"."account_role" AS ENUM (
    'owner',
    'member'
);
--> statement-breakpoint
ALTER TYPE "basejump"."account_role" OWNER TO "postgres";
--> statement-breakpoint
CREATE TYPE "basejump"."invitation_type" AS ENUM (
    'one_time',
    '24_hour'
);
--> statement-breakpoint
ALTER TYPE "basejump"."invitation_type" OWNER TO "postgres";
--> statement-breakpoint
CREATE TYPE "basejump"."subscription_status" AS ENUM (
    'trialing',
    'active',
    'canceled',
    'incomplete',
    'incomplete_expired',
    'past_due',
    'unpaid'
);
--> statement-breakpoint
ALTER TYPE "basejump"."subscription_status" OWNER TO "postgres";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "basejump"."add_current_user_to_new_account"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    if new.primary_owner_user_id = auth.uid() then
        insert into basejump.account_user (account_id, user_id, account_role)
        values (NEW.id, auth.uid(), 'owner');
    end if;
    return NEW;
end;
$$;
--> statement-breakpoint
ALTER FUNCTION "basejump"."add_current_user_to_new_account"() OWNER TO "postgres";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "basejump"."ensure_billing_customer_email"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    user_email TEXT;
    owner_id UUID;
BEGIN
    IF NEW.email IS NULL OR NEW.email = '' THEN
        SELECT primary_owner_user_id INTO owner_id
        FROM basejump.accounts
        WHERE id = NEW.account_id;
        
        user_email := public.get_user_email(owner_id);
        
        IF user_email IS NOT NULL THEN
            NEW.email := user_email;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION "basejump"."ensure_billing_customer_email"() OWNER TO "postgres";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "basejump"."generate_token"("length" integer) RETURNS "text"
    LANGUAGE "sql"
    AS $$
select regexp_replace(replace(
                              replace(replace(replace(encode(gen_random_bytes(length)::bytea, 'base64'), '/', ''), '+',
                                              ''), '\', ''),
                              '=',
                              ''), E'[\\n\\r]+', '', 'g');
$$;
--> statement-breakpoint
ALTER FUNCTION "basejump"."generate_token"("length" integer) OWNER TO "postgres";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "basejump"."get_accounts_with_role"("passed_in_role" "basejump"."account_role" DEFAULT NULL::"basejump"."account_role") RETURNS SETOF "uuid"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
select account_id
from basejump.account_user wu
where wu.user_id = auth.uid()
  and (
            wu.account_role = passed_in_role
        or passed_in_role is null
    );
$$;
--> statement-breakpoint
ALTER FUNCTION "basejump"."get_accounts_with_role"("passed_in_role" "basejump"."account_role") OWNER TO "postgres";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "basejump"."get_config"() RETURNS "json"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    result RECORD;
BEGIN
    SELECT * from basejump.config limit 1 into result;
    return row_to_json(result);
END;
$$;
--> statement-breakpoint
ALTER FUNCTION "basejump"."get_config"() OWNER TO "postgres";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "basejump"."has_role_on_account"("account_id" "uuid", "account_role" "basejump"."account_role" DEFAULT NULL::"basejump"."account_role") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
select exists(
               select 1
               from basejump.account_user wu
               where wu.user_id = auth.uid()
                 and wu.account_id = has_role_on_account.account_id
                 and (
                           wu.account_role = has_role_on_account.account_role
                       or has_role_on_account.account_role is null
                   )
           );
$$;
--> statement-breakpoint
ALTER FUNCTION "basejump"."has_role_on_account"("account_id" "uuid", "account_role" "basejump"."account_role") OWNER TO "postgres";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "basejump"."is_set"("field_name" "text") RETURNS boolean
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    result BOOLEAN;
BEGIN
    execute format('select %I from basejump.config limit 1', field_name) into result;
    return result;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION "basejump"."is_set"("field_name" "text") OWNER TO "postgres";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "basejump"."protect_account_fields"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    IF current_user IN ('authenticated', 'anon') THEN
        -- these are protected fields that users are not allowed to update themselves
        -- platform admins should be VERY careful about updating them as well.
        if NEW.id <> OLD.id
            OR NEW.personal_account <> OLD.personal_account
            OR NEW.primary_owner_user_id <> OLD.primary_owner_user_id
        THEN
            RAISE EXCEPTION 'You do not have permission to update this field';
        end if;
    end if;

    RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION "basejump"."protect_account_fields"() OWNER TO "postgres";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "basejump"."run_new_user_setup"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    first_account_id    uuid;
    generated_user_name text;
begin

    -- first we setup the user profile
    -- TODO: see if we can get the user's name from the auth.users table once we learn how oauth works
    if new.email IS NOT NULL then
        generated_user_name := split_part(new.email, '@', 1);
    end if;
    -- create the new users's personal account
    insert into basejump.accounts (name, primary_owner_user_id, personal_account, id)
    values (generated_user_name, NEW.id, true, NEW.id)
    returning id into first_account_id;

    -- add them to the account_user table so they can act on it
    insert into basejump.account_user (account_id, user_id, account_role)
    values (first_account_id, NEW.id, 'owner');

    return NEW;
end;
$$;
--> statement-breakpoint
ALTER FUNCTION "basejump"."run_new_user_setup"() OWNER TO "postgres";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "basejump"."slugify_account_slug"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    if NEW.slug is not null then
        NEW.slug = lower(regexp_replace(NEW.slug, '[^a-zA-Z0-9-]+', '-', 'g'));
    end if;

    RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION "basejump"."slugify_account_slug"() OWNER TO "postgres";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "basejump"."trigger_set_invitation_details"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.invited_by_user_id = auth.uid();
    NEW.account_name = (select name from basejump.accounts where id = NEW.account_id);
    RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION "basejump"."trigger_set_invitation_details"() OWNER TO "postgres";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "basejump"."trigger_set_timestamps"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    if TG_OP = 'INSERT' then
        NEW.created_at = now();
        NEW.updated_at = now();
    else
        NEW.updated_at = now();
        NEW.created_at = OLD.created_at;
    end if;
    RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION "basejump"."trigger_set_timestamps"() OWNER TO "postgres";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "basejump"."trigger_set_user_tracking"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    if TG_OP = 'INSERT' then
        NEW.created_by = auth.uid();
        NEW.updated_by = auth.uid();
    else
        NEW.updated_by = auth.uid();
        NEW.created_by = OLD.created_by;
    end if;
    RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION "basejump"."trigger_set_user_tracking"() OWNER TO "postgres";
--> statement-breakpoint
SET default_tablespace = '';
--> statement-breakpoint
SET default_table_access_method = "heap";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "basejump"."account_user" (
    "user_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "account_role" "basejump"."account_role" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "basejump"."account_user" OWNER TO "postgres";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "basejump"."accounts" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "primary_owner_user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "name" "text",
    "slug" "text",
    "personal_account" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone,
    "created_at" timestamp with time zone,
    "created_by" "uuid",
    "updated_by" "uuid",
    "private_metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "public_metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "memory_enabled" boolean DEFAULT true,
    CONSTRAINT "basejump_accounts_slug_null_if_personal_account_true" CHECK (((("personal_account" = true) AND ("slug" IS NULL)) OR (("personal_account" = false) AND ("slug" IS NOT NULL))))
);
--> statement-breakpoint
ALTER TABLE "basejump"."accounts" OWNER TO "postgres";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "basejump"."billing_customers" (
    "account_id" "uuid" NOT NULL,
    "id" "text" NOT NULL,
    "email" "text",
    "active" boolean,
    "provider" "text"
);
--> statement-breakpoint
ALTER TABLE "basejump"."billing_customers" OWNER TO "postgres";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "basejump"."billing_subscriptions" (
    "id" "text" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "billing_customer_id" "text" NOT NULL,
    "status" "basejump"."subscription_status",
    "metadata" "jsonb",
    "price_id" "text",
    "plan_name" "text",
    "quantity" integer,
    "cancel_at_period_end" boolean,
    "created" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "current_period_start" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "current_period_end" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "ended_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "cancel_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "canceled_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "trial_start" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "trial_end" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "provider" "text"
);
--> statement-breakpoint
ALTER TABLE "basejump"."billing_subscriptions" OWNER TO "postgres";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "basejump"."config" (
    "enable_team_accounts" boolean DEFAULT true,
    "enable_personal_account_billing" boolean DEFAULT true,
    "enable_team_account_billing" boolean DEFAULT true,
    "billing_provider" "text" DEFAULT 'stripe'::"text"
);
--> statement-breakpoint
ALTER TABLE "basejump"."config" OWNER TO "postgres";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "basejump"."invitations" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "account_role" "basejump"."account_role" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "token" "text" DEFAULT "basejump"."generate_token"(30) NOT NULL,
    "invited_by_user_id" "uuid" NOT NULL,
    "account_name" "text",
    "updated_at" timestamp with time zone,
    "created_at" timestamp with time zone,
    "invitation_type" "basejump"."invitation_type" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "basejump"."invitations" OWNER TO "postgres";
--> statement-breakpoint
ALTER TABLE ONLY "basejump"."account_user"
    ADD CONSTRAINT "account_user_pkey" PRIMARY KEY ("user_id", "account_id");
--> statement-breakpoint
ALTER TABLE ONLY "basejump"."accounts"
    ADD CONSTRAINT "accounts_pkey" PRIMARY KEY ("id");
--> statement-breakpoint
ALTER TABLE ONLY "basejump"."accounts"
    ADD CONSTRAINT "accounts_slug_key" UNIQUE ("slug");
--> statement-breakpoint
ALTER TABLE ONLY "basejump"."billing_customers"
    ADD CONSTRAINT "billing_customers_pkey" PRIMARY KEY ("id");
--> statement-breakpoint
ALTER TABLE ONLY "basejump"."billing_subscriptions"
    ADD CONSTRAINT "billing_subscriptions_pkey" PRIMARY KEY ("id");
--> statement-breakpoint
ALTER TABLE ONLY "basejump"."invitations"
    ADD CONSTRAINT "invitations_pkey" PRIMARY KEY ("id");
--> statement-breakpoint
ALTER TABLE ONLY "basejump"."invitations"
    ADD CONSTRAINT "invitations_token_key" UNIQUE ("token");
--> statement-breakpoint
CREATE INDEX "idx_account_user_composite" ON "basejump"."account_user" USING "btree" ("user_id", "account_id");
--> statement-breakpoint
CREATE INDEX "idx_account_user_user_account" ON "basejump"."account_user" USING "btree" ("user_id", "account_id");
--> statement-breakpoint
CREATE INDEX "idx_accounts_created_at_desc" ON "basejump"."accounts" USING "btree" ("created_at" DESC);
--> statement-breakpoint
CREATE INDEX "idx_accounts_memory_enabled" ON "basejump"."accounts" USING "btree" ("id") WHERE ("memory_enabled" = false);
--> statement-breakpoint
CREATE INDEX "idx_accounts_primary_owner_personal" ON "basejump"."accounts" USING "btree" ("primary_owner_user_id", "personal_account");
--> statement-breakpoint
CREATE INDEX "idx_basejump_account_user_user_id" ON "basejump"."account_user" USING "btree" ("user_id");
--> statement-breakpoint
CREATE INDEX "idx_billing_customers_account_id" ON "basejump"."billing_customers" USING "btree" ("account_id");
--> statement-breakpoint
CREATE INDEX "idx_billing_customers_email_gin" ON "basejump"."billing_customers" USING "gin" ("lower"("email") "public"."gin_trgm_ops");
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "auto_create_free_tier_on_account" AFTER INSERT ON "basejump"."accounts" FOR EACH ROW EXECUTE FUNCTION "public"."initialize_free_tier_credits"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "basejump_add_current_user_to_new_account" AFTER INSERT ON "basejump"."accounts" FOR EACH ROW EXECUTE FUNCTION "basejump"."add_current_user_to_new_account"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "basejump_protect_account_fields" BEFORE UPDATE ON "basejump"."accounts" FOR EACH ROW EXECUTE FUNCTION "basejump"."protect_account_fields"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "basejump_set_accounts_timestamp" BEFORE INSERT OR UPDATE ON "basejump"."accounts" FOR EACH ROW EXECUTE FUNCTION "basejump"."trigger_set_timestamps"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "basejump_set_accounts_user_tracking" BEFORE INSERT OR UPDATE ON "basejump"."accounts" FOR EACH ROW EXECUTE FUNCTION "basejump"."trigger_set_user_tracking"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "basejump_set_invitations_timestamp" BEFORE INSERT OR UPDATE ON "basejump"."invitations" FOR EACH ROW EXECUTE FUNCTION "basejump"."trigger_set_timestamps"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "basejump_slugify_account_slug" BEFORE INSERT OR UPDATE ON "basejump"."accounts" FOR EACH ROW EXECUTE FUNCTION "basejump"."slugify_account_slug"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "basejump_trigger_set_invitation_details" BEFORE INSERT ON "basejump"."invitations" FOR EACH ROW EXECUTE FUNCTION "basejump"."trigger_set_invitation_details"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "ensure_billing_customer_email_trigger" BEFORE INSERT OR UPDATE ON "basejump"."billing_customers" FOR EACH ROW EXECUTE FUNCTION "basejump"."ensure_billing_customer_email"();
--> statement-breakpoint
ALTER TABLE ONLY "basejump"."account_user"
    ADD CONSTRAINT "account_user_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "basejump"."accounts"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY "basejump"."account_user"
    ADD CONSTRAINT "account_user_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY "basejump"."accounts"
    ADD CONSTRAINT "accounts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");
--> statement-breakpoint
ALTER TABLE ONLY "basejump"."accounts"
    ADD CONSTRAINT "accounts_primary_owner_user_id_fkey" FOREIGN KEY ("primary_owner_user_id") REFERENCES "auth"."users"("id");
--> statement-breakpoint
ALTER TABLE ONLY "basejump"."accounts"
    ADD CONSTRAINT "accounts_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");
--> statement-breakpoint
ALTER TABLE ONLY "basejump"."billing_customers"
    ADD CONSTRAINT "billing_customers_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "basejump"."accounts"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY "basejump"."billing_subscriptions"
    ADD CONSTRAINT "billing_subscriptions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "basejump"."accounts"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY "basejump"."billing_subscriptions"
    ADD CONSTRAINT "billing_subscriptions_billing_customer_id_fkey" FOREIGN KEY ("billing_customer_id") REFERENCES "basejump"."billing_customers"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY "basejump"."invitations"
    ADD CONSTRAINT "invitations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "basejump"."accounts"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY "basejump"."invitations"
    ADD CONSTRAINT "invitations_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "auth"."users"("id");
--> statement-breakpoint
CREATE POLICY "Account users can be deleted by owners except primary account o" ON "basejump"."account_user" FOR DELETE TO "authenticated" USING ((("basejump"."has_role_on_account"("account_id", 'owner'::"basejump"."account_role") = true) AND ("user_id" <> ( SELECT "accounts"."primary_owner_user_id"
   FROM "basejump"."accounts"
  WHERE ("account_user"."account_id" = "accounts"."id")))));
--> statement-breakpoint
CREATE POLICY "Accounts are viewable by members" ON "basejump"."accounts" FOR SELECT TO "authenticated" USING (("basejump"."has_role_on_account"("id") = true));
--> statement-breakpoint
CREATE POLICY "Accounts are viewable by primary owner" ON "basejump"."accounts" FOR SELECT TO "authenticated" USING (("primary_owner_user_id" = "auth"."uid"()));
--> statement-breakpoint
CREATE POLICY "Accounts can be edited by owners" ON "basejump"."accounts" FOR UPDATE TO "authenticated" USING (("basejump"."has_role_on_account"("id", 'owner'::"basejump"."account_role") = true));
--> statement-breakpoint
CREATE POLICY "Basejump settings can be read by authenticated users" ON "basejump"."config" FOR SELECT TO "authenticated" USING (true);
--> statement-breakpoint
CREATE POLICY "Can only view own billing customer data." ON "basejump"."billing_customers" FOR SELECT USING (("basejump"."has_role_on_account"("account_id") = true));
--> statement-breakpoint
CREATE POLICY "Can only view own billing subscription data." ON "basejump"."billing_subscriptions" FOR SELECT USING (("basejump"."has_role_on_account"("account_id") = true));
--> statement-breakpoint
CREATE POLICY "Invitations can be created by account owners" ON "basejump"."invitations" FOR INSERT TO "authenticated" WITH CHECK ((("basejump"."is_set"('enable_team_accounts'::"text") = true) AND (( SELECT "accounts"."personal_account"
   FROM "basejump"."accounts"
  WHERE ("accounts"."id" = "invitations"."account_id")) = false) AND ("basejump"."has_role_on_account"("account_id", 'owner'::"basejump"."account_role") = true)));
--> statement-breakpoint
CREATE POLICY "Invitations can be deleted by account owners" ON "basejump"."invitations" FOR DELETE TO "authenticated" USING (("basejump"."has_role_on_account"("account_id", 'owner'::"basejump"."account_role") = true));
--> statement-breakpoint
CREATE POLICY "Invitations viewable by account owners" ON "basejump"."invitations" FOR SELECT TO "authenticated" USING ((("created_at" > ("now"() - '24:00:00'::interval)) AND ("basejump"."has_role_on_account"("account_id", 'owner'::"basejump"."account_role") = true)));
--> statement-breakpoint
CREATE POLICY "Team accounts can be created by any user" ON "basejump"."accounts" FOR INSERT TO "authenticated" WITH CHECK ((("basejump"."is_set"('enable_team_accounts'::"text") = true) AND ("personal_account" = false)));
--> statement-breakpoint
ALTER TABLE "basejump"."account_user" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "basejump"."accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "basejump"."billing_customers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "basejump"."billing_subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "basejump"."config" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "basejump"."invitations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "users can view their own account_users" ON "basejump"."account_user" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));
--> statement-breakpoint
CREATE POLICY "users can view their teammates" ON "basejump"."account_user" FOR SELECT TO "authenticated" USING (("basejump"."has_role_on_account"("account_id") = true));
--> statement-breakpoint
GRANT USAGE ON SCHEMA "basejump" TO "authenticated";
--> statement-breakpoint
GRANT USAGE ON SCHEMA "basejump" TO "service_role";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "basejump"."add_current_user_to_new_account"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "basejump"."ensure_billing_customer_email"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "basejump"."generate_token"("length" integer) FROM PUBLIC;
--> statement-breakpoint
GRANT ALL ON FUNCTION "basejump"."generate_token"("length" integer) TO "authenticated";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "basejump"."get_accounts_with_role"("passed_in_role" "basejump"."account_role") FROM PUBLIC;
--> statement-breakpoint
GRANT ALL ON FUNCTION "basejump"."get_accounts_with_role"("passed_in_role" "basejump"."account_role") TO "authenticated";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "basejump"."get_config"() FROM PUBLIC;
--> statement-breakpoint
GRANT ALL ON FUNCTION "basejump"."get_config"() TO "authenticated";
--> statement-breakpoint
GRANT ALL ON FUNCTION "basejump"."get_config"() TO "service_role";
--> statement-breakpoint
GRANT ALL ON FUNCTION "basejump"."has_role_on_account"("account_id" "uuid", "account_role" "basejump"."account_role") TO "authenticated";
--> statement-breakpoint
GRANT ALL ON FUNCTION "basejump"."has_role_on_account"("account_id" "uuid", "account_role" "basejump"."account_role") TO "anon";
--> statement-breakpoint
GRANT ALL ON FUNCTION "basejump"."has_role_on_account"("account_id" "uuid", "account_role" "basejump"."account_role") TO "service_role";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "basejump"."is_set"("field_name" "text") FROM PUBLIC;
--> statement-breakpoint
GRANT ALL ON FUNCTION "basejump"."is_set"("field_name" "text") TO "authenticated";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "basejump"."protect_account_fields"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "basejump"."run_new_user_setup"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "basejump"."slugify_account_slug"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "basejump"."trigger_set_invitation_details"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "basejump"."trigger_set_timestamps"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "basejump"."trigger_set_user_tracking"() FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "basejump"."account_user" TO "authenticated";
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "basejump"."account_user" TO "service_role";
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "basejump"."accounts" TO "authenticated";
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "basejump"."accounts" TO "service_role";
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "basejump"."billing_customers" TO "service_role";
--> statement-breakpoint
GRANT SELECT ON TABLE "basejump"."billing_customers" TO "authenticated";
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "basejump"."billing_subscriptions" TO "service_role";
--> statement-breakpoint
GRANT SELECT ON TABLE "basejump"."billing_subscriptions" TO "authenticated";
--> statement-breakpoint
GRANT SELECT ON TABLE "basejump"."config" TO "authenticated";
--> statement-breakpoint
GRANT SELECT ON TABLE "basejump"."config" TO "service_role";
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "basejump"."invitations" TO "authenticated";
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "basejump"."invitations" TO "service_role";
--> statement-breakpoint
RESET ALL;
--> statement-breakpoint
-- public: atomic credit RPC functions (operate on kortix.credit_accounts)
CREATE OR REPLACE FUNCTION public.atomic_add_credits(p_account_id uuid, p_amount numeric, p_is_expiring boolean DEFAULT true, p_description text DEFAULT 'Credit added'::text, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_type text DEFAULT NULL::text, p_stripe_event_id text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
    v_current_expiring NUMERIC(10, 2);
    v_current_non_expiring NUMERIC(10, 2);
    v_current_balance NUMERIC(10, 2);
    v_new_expiring NUMERIC(10, 2);
    v_new_non_expiring NUMERIC(10, 2);
    v_new_total NUMERIC(10, 2);
    v_tier TEXT;
    v_ledger_id UUID;
BEGIN
    -- Idempotency: check stripe_event_id
    IF p_stripe_event_id IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM kortix.credit_ledger
            WHERE stripe_event_id = p_stripe_event_id
        ) THEN
            RETURN jsonb_build_object(
                'success', true,
                'message', 'Credit already added (duplicate prevented)',
                'duplicate_prevented', true
            );
        END IF;
    END IF;

    -- Idempotency: check idempotency_key
    IF p_idempotency_key IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM kortix.credit_ledger
            WHERE idempotency_key = p_idempotency_key
            AND created_at > NOW() - INTERVAL '1 hour'
        ) THEN
            RETURN jsonb_build_object(
                'success', true,
                'message', 'Credit already added (idempotent)',
                'duplicate_prevented', true
            );
        END IF;
    END IF;

    SELECT expiring_credits, non_expiring_credits, balance, tier
    INTO v_current_expiring, v_current_non_expiring, v_current_balance, v_tier
    FROM kortix.credit_accounts
    WHERE account_id = p_account_id
    FOR UPDATE;

    IF NOT FOUND THEN
        v_current_expiring := 0;
        v_current_non_expiring := 0;
        v_current_balance := 0;
        v_tier := 'none';

        INSERT INTO kortix.credit_accounts (
            account_id, expiring_credits, non_expiring_credits, balance, tier
        ) VALUES (
            p_account_id, 0, 0, 0, v_tier
        );
    END IF;

    IF p_is_expiring THEN
        v_new_expiring := v_current_expiring + p_amount;
        v_new_non_expiring := v_current_non_expiring;
    ELSE
        v_new_expiring := v_current_expiring;
        v_new_non_expiring := v_current_non_expiring + p_amount;
    END IF;

    v_new_total := v_new_expiring + v_new_non_expiring;

    UPDATE kortix.credit_accounts
    SET
        expiring_credits = v_new_expiring,
        non_expiring_credits = v_new_non_expiring,
        balance = v_new_total,
        updated_at = NOW()
    WHERE account_id = p_account_id;

    INSERT INTO kortix.credit_ledger (
        account_id, amount, balance_after, type, description,
        is_expiring, expires_at, stripe_event_id, idempotency_key, processing_source
    ) VALUES (
        p_account_id, p_amount, v_new_total,
        COALESCE(p_type, CASE WHEN p_is_expiring THEN 'tier_grant' ELSE 'purchase' END),
        p_description, p_is_expiring, p_expires_at,
        p_stripe_event_id, p_idempotency_key, 'atomic_function'
    ) RETURNING id INTO v_ledger_id;

    RETURN jsonb_build_object(
        'success', true,
        'expiring_credits', v_new_expiring,
        'non_expiring_credits', v_new_non_expiring,
        'total_balance', v_new_total,
        'ledger_id', v_ledger_id
    );
END;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.atomic_daily_credit_refresh(p_account_id uuid, p_credit_amount numeric, p_tier text, p_processed_by text, p_refresh_interval_hours integer DEFAULT 24)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_last_refresh TIMESTAMPTZ;
    v_now TIMESTAMPTZ := NOW();
    v_refresh_date DATE := v_now::DATE;
    v_already_refreshed BOOLEAN;
    v_interval INTERVAL;
    v_should_refresh BOOLEAN := FALSE;
    v_old_daily NUMERIC(10, 2);
    v_old_total NUMERIC(10, 2);
    v_new_daily NUMERIC(10, 2);
    v_new_total NUMERIC(10, 2);
    v_tracking_id UUID;
    v_credits_added NUMERIC(10, 2);
BEGIN
    v_interval := (p_refresh_interval_hours || ' hours')::INTERVAL;
    
    -- Lock and get current state
    SELECT last_daily_refresh, daily_credits_balance, balance
    INTO v_last_refresh, v_old_daily, v_old_total
    FROM credit_accounts
    WHERE account_id = p_account_id
    FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'account_not_found',
            'duplicate_prevented', false
        );
    END IF;
    
    -- Check if already refreshed today (using tracking table for idempotency)
    SELECT EXISTS(
        SELECT 1 FROM daily_refresh_tracking
        WHERE account_id = p_account_id
        AND refresh_date = v_refresh_date
    ) INTO v_already_refreshed;
    
    IF v_already_refreshed THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'already_refreshed_today',
            'duplicate_prevented', true,
            'refresh_date', v_refresh_date
        );
    END IF;
    
    -- Check if interval has elapsed
    IF v_last_refresh IS NULL THEN
        v_should_refresh := TRUE;
    ELSIF v_now - v_last_refresh > v_interval THEN
        v_should_refresh := TRUE;
    END IF;
    
    IF NOT v_should_refresh THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'interval_not_elapsed',
            'duplicate_prevented', false,
            'last_refresh', v_last_refresh,
            'next_refresh', v_last_refresh + v_interval
        );
    END IF;
    
    -- Insert tracking record (idempotency check)
    INSERT INTO daily_refresh_tracking (
        account_id,
        refresh_date,
        credits_granted,
        tier,
        processed_by
    ) VALUES (
        p_account_id,
        v_refresh_date,
        p_credit_amount,
        p_tier,
        p_processed_by
    )
    ON CONFLICT (account_id, refresh_date) DO NOTHING
    RETURNING id INTO v_tracking_id;
    
    IF v_tracking_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'concurrent_refresh_prevented',
            'duplicate_prevented', true,
            'refresh_date', v_refresh_date
        );
    END IF;
    
    -- Reset daily credits to the configured amount (don't touch monthly!)
    v_new_daily := p_credit_amount;
    v_credits_added := p_credit_amount - COALESCE(v_old_daily, 0);
    v_new_total := v_old_total + v_credits_added;
    
    UPDATE credit_accounts
    SET
        daily_credits_balance = v_new_daily,
        balance = v_new_total,
        last_daily_refresh = v_now,
        updated_at = v_now
    WHERE account_id = p_account_id;
    
    -- Log to ledger
    INSERT INTO credit_ledger (
        account_id,
        amount,
        balance_after,
        type,
        description,
        is_expiring,
        expires_at,
        metadata
    ) VALUES (
        p_account_id,
        v_credits_added,
        v_new_total,
        'daily_refresh',
        format('Daily credits refresh: %s → %s', COALESCE(v_old_daily, 0), v_new_daily),
        TRUE,
        v_now + v_interval,
        jsonb_build_object(
            'tier', p_tier,
            'refresh_date', v_refresh_date,
            'old_daily', v_old_daily,
            'new_daily', v_new_daily,
            'refresh_interval_hours', p_refresh_interval_hours,
            'tracking_id', v_tracking_id
        )
    );
    
    RAISE NOTICE '[DAILY REFRESH] Account % daily credits: % → % (total: %)', 
        p_account_id, v_old_daily, v_new_daily, v_new_total;
    
    RETURN jsonb_build_object(
        'success', true,
        'credits_granted', v_credits_added,
        'new_daily_balance', v_new_daily,
        'new_total_balance', v_new_total,
        'refresh_date', v_refresh_date,
        'old_daily', v_old_daily,
        'duplicate_prevented', false,
        'tracking_id', v_tracking_id
    );
END;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.atomic_grant_renewal_credits(p_account_id uuid, p_period_start bigint, p_period_end bigint, p_credits numeric, p_processed_by text, p_invoice_id text DEFAULT NULL::text, p_stripe_event_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
    v_already_processed BOOLEAN;
    v_existing_processor TEXT;
    v_current_non_expiring NUMERIC(10, 2);
    v_new_total NUMERIC(10, 2);
    v_expires_at TIMESTAMP WITH TIME ZONE;
BEGIN
    SELECT EXISTS(
        SELECT 1 FROM public.renewal_processing
        WHERE account_id = p_account_id AND period_start = p_period_start
    ), (
        SELECT processed_by FROM public.renewal_processing
        WHERE account_id = p_account_id AND period_start = p_period_start
        LIMIT 1
    ) INTO v_already_processed, v_existing_processor;

    IF v_already_processed THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'already_processed',
            'processed_by', v_existing_processor,
            'duplicate_prevented', true
        );
    END IF;

    INSERT INTO public.renewal_processing (
        account_id, period_start, period_end, subscription_id,
        processed_by, credits_granted, stripe_event_id
    )
    SELECT p_account_id, p_period_start, p_period_end, stripe_subscription_id,
           p_processed_by, p_credits, p_stripe_event_id
    FROM kortix.credit_accounts
    WHERE account_id = p_account_id;

    SELECT non_expiring_credits INTO v_current_non_expiring
    FROM kortix.credit_accounts WHERE account_id = p_account_id;

    v_current_non_expiring := COALESCE(v_current_non_expiring, 0);
    v_new_total := p_credits + v_current_non_expiring;
    v_expires_at := TO_TIMESTAMP(p_period_end);

    UPDATE kortix.credit_accounts
    SET
        expiring_credits = p_credits,
        balance = v_new_total,
        last_grant_date = TO_TIMESTAMP(p_period_start),
        next_credit_grant = TO_TIMESTAMP(p_period_end),
        last_processed_invoice_id = COALESCE(p_invoice_id, last_processed_invoice_id),
        last_renewal_period_start = p_period_start,
        updated_at = NOW()
    WHERE account_id = p_account_id;

    INSERT INTO kortix.credit_ledger (
        account_id, amount, balance_after, type, description,
        is_expiring, expires_at, stripe_event_id, processing_source
    ) VALUES (
        p_account_id, p_credits, v_new_total, 'tier_grant',
        'Monthly renewal: ' || p_processed_by,
        true, v_expires_at, p_stripe_event_id, p_processed_by
    );

    RETURN jsonb_build_object(
        'success', true,
        'credits_granted', p_credits,
        'new_balance', v_new_total,
        'expiring_credits', p_credits,
        'non_expiring_credits', v_current_non_expiring,
        'processed_by', p_processed_by
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'reason', 'error',
        'error', SQLERRM
    );
END;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.atomic_reset_expiring_credits(p_account_id uuid, p_new_credits numeric, p_description text DEFAULT 'Monthly credit renewal'::text, p_stripe_event_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
    v_current_balance NUMERIC(10, 2);
    v_current_expiring NUMERIC(10, 2);
    v_current_non_expiring NUMERIC(10, 2);
    v_actual_non_expiring NUMERIC(10, 2);
    v_new_total NUMERIC(10, 2);
    v_expires_at TIMESTAMP WITH TIME ZONE;
BEGIN
    SELECT balance, expiring_credits, non_expiring_credits
    INTO v_current_balance, v_current_expiring, v_current_non_expiring
    FROM kortix.credit_accounts
    WHERE account_id = p_account_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Account not found');
    END IF;

    IF v_current_balance <= v_current_non_expiring THEN
        v_actual_non_expiring := v_current_balance;
    ELSE
        v_actual_non_expiring := v_current_non_expiring;
    END IF;

    v_new_total := p_new_credits + v_actual_non_expiring;
    v_expires_at := DATE_TRUNC('month', NOW() + INTERVAL '1 month') + INTERVAL '1 month';

    UPDATE kortix.credit_accounts
    SET
        expiring_credits = p_new_credits,
        non_expiring_credits = v_actual_non_expiring,
        balance = v_new_total,
        updated_at = NOW()
    WHERE account_id = p_account_id;

    INSERT INTO kortix.credit_ledger (
        account_id, amount, balance_after, type, description,
        is_expiring, expires_at, stripe_event_id, metadata, processing_source
    ) VALUES (
        p_account_id, p_new_credits, v_new_total, 'tier_grant', p_description,
        true, v_expires_at, p_stripe_event_id,
        jsonb_build_object(
            'renewal', true,
            'non_expiring_preserved', v_actual_non_expiring,
            'previous_balance', v_current_balance
        ),
        'atomic_function'
    );

    RETURN jsonb_build_object(
        'success', true,
        'new_expiring', p_new_credits,
        'non_expiring', v_actual_non_expiring,
        'total_balance', v_new_total
    );
END;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.atomic_use_credits(p_account_id uuid, p_amount numeric, p_description text DEFAULT 'Credit usage'::text, p_thread_id text DEFAULT NULL::text, p_message_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
    DECLARE
      v_daily NUMERIC(10,2); v_exp NUMERIC(10,2); v_nonexp NUMERIC(10,2); v_total NUMERIC(10,2);
      v_fd NUMERIC(10,2):=0; v_fe NUMERIC(10,2):=0; v_fn NUMERIC(10,2):=0;
      v_rem NUMERIC(10,2); v_nd NUMERIC(10,2); v_ne NUMERIC(10,2); v_nn NUMERIC(10,2); v_nt NUMERIC(10,2);
      v_tid UUID;
    BEGIN
      SELECT COALESCE(daily_credits_balance,0),COALESCE(expiring_credits,0),
             COALESCE(non_expiring_credits,0),COALESCE(balance,0)
      INTO v_daily,v_exp,v_nonexp,v_total
      FROM kortix.credit_accounts WHERE account_id=p_account_id FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','No credit account found','required',p_amount,'available',0); END IF;
      v_rem:=p_amount;
      IF v_rem>0 AND v_daily>0 THEN IF v_daily>=v_rem THEN v_fd:=v_rem;v_rem:=0; ELSE v_fd:=v_daily;v_rem:=v_rem-v_daily; END IF; END IF;
      IF v_rem>0 AND v_exp>0 THEN IF v_exp>=v_rem THEN v_fe:=v_rem;v_rem:=0; ELSE v_fe:=v_exp;v_rem:=v_rem-v_exp; END IF; END IF;
      IF v_rem>0 THEN v_fn:=v_rem;v_rem:=0; END IF;
      v_nd:=v_daily-v_fd; v_ne:=v_exp-v_fe; v_nn:=v_nonexp-v_fn; v_nt:=v_nd+v_ne+v_nn;
      UPDATE kortix.credit_accounts SET daily_credits_balance=v_nd,expiring_credits=v_ne,
        non_expiring_credits=v_nn,balance=v_nt,updated_at=NOW() WHERE account_id=p_account_id;
      INSERT INTO kortix.credit_ledger(account_id,amount,balance_after,type,description,metadata)
      VALUES(p_account_id,-p_amount,v_nt,'usage',p_description,
        jsonb_build_object('from_daily',v_fd,'from_monthly',v_fe,'from_extra',v_fn,'thread_id',p_thread_id,'message_id',p_message_id))
      RETURNING id INTO v_tid;
      RETURN jsonb_build_object('success',true,'amount_deducted',p_amount,'new_total',v_nt,
        'new_daily',v_nd,'new_expiring',v_ne,'new_non_expiring',v_nn,
        'from_daily',v_fd,'from_monthly',v_fe,'from_extra',v_fn,
        'from_expiring',v_fe,'from_non_expiring',v_fn,'transaction_id',v_tid);
    END; $function$
;
--> statement-breakpoint
-- public: welcome-email webhook function (before its trigger)
CREATE OR REPLACE FUNCTION public.trigger_welcome_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  backend_url TEXT;
  webhook_secret TEXT;
  payload JSONB;
  request_id BIGINT;
  config_exists BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.webhook_config WHERE id = 1) INTO config_exists;
  
  IF NOT config_exists THEN
    RAISE WARNING 'Webhook not configured. Run: INSERT INTO public.webhook_config (backend_url, webhook_secret) VALUES (''https://your-url'', ''your-secret'');';
    RETURN NEW;
  END IF;
  
  SELECT wc.backend_url, wc.webhook_secret 
  INTO backend_url, webhook_secret
  FROM public.webhook_config wc
  WHERE wc.id = 1;
  
  IF backend_url IS NULL OR backend_url = '' THEN
    RAISE WARNING 'backend_url not configured in webhook_config table';
    RETURN NEW;
  END IF;
  
  IF webhook_secret IS NULL OR webhook_secret = '' THEN
    RAISE WARNING 'webhook_secret not configured in webhook_config table';
    RETURN NEW;
  END IF;
  
  payload := jsonb_build_object(
    'type', 'INSERT',
    'table', 'users',
    'schema', 'auth',
    'record', jsonb_build_object(
      'id', NEW.id,
      'email', NEW.email,
      'raw_user_meta_data', NEW.raw_user_meta_data,
      'created_at', NEW.created_at
    )
  );
  
  SELECT net.http_post(
    url := backend_url || '/v1/webhooks/user-created',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Webhook-Secret', webhook_secret
    ),
    body := payload
  ) INTO request_id;
  
  RAISE LOG 'Welcome email webhook triggered for user % with request_id %', NEW.email, request_id;
  
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Failed to trigger welcome email webhook for user %: %', NEW.email, SQLERRM;
    RETURN NEW;
END;
$function$
;
--> statement-breakpoint
-- auth.users signup triggers
drop trigger if exists on_auth_user_created on auth.users;
--> statement-breakpoint
drop trigger if exists on_auth_user_created_webhook on auth.users;
--> statement-breakpoint
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION basejump.run_new_user_setup();
--> statement-breakpoint
CREATE TRIGGER on_auth_user_created_webhook AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION trigger_welcome_email();
--> statement-breakpoint
-- storage buckets
insert into storage.buckets (id,name,public) values ('agent-profile-images','agent-profile-images','t') on conflict (id) do nothing;
--> statement-breakpoint
insert into storage.buckets (id,name,public) values ('avatars','avatars','t') on conflict (id) do nothing;
--> statement-breakpoint
insert into storage.buckets (id,name,public) values ('browser-screenshots','browser-screenshots','t') on conflict (id) do nothing;
--> statement-breakpoint
insert into storage.buckets (id,name,public) values ('file-uploads','file-uploads','f') on conflict (id) do nothing;
--> statement-breakpoint
insert into storage.buckets (id,name,public) values ('image-uploads','image-uploads','t') on conflict (id) do nothing;
--> statement-breakpoint
insert into storage.buckets (id,name,public) values ('legacy-migrations','legacy-migrations','f') on conflict (id) do nothing;
--> statement-breakpoint
insert into storage.buckets (id,name,public) values ('recordings','recordings','f') on conflict (id) do nothing;
--> statement-breakpoint
insert into storage.buckets (id,name,public) values ('staged-files','staged-files','f') on conflict (id) do nothing;
--> statement-breakpoint
insert into storage.buckets (id,name,public) values ('ui_grounding','ui_grounding','f') on conflict (id) do nothing;
--> statement-breakpoint
insert into storage.buckets (id,name,public) values ('ui_grounding_trajs','ui_grounding_trajs','f') on conflict (id) do nothing;
