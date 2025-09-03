create extension if not exists "pg_net" with schema "public" version '0.14.0';

create table "public"."google_oauth_tokens" (
    "created_at" timestamp with time zone not null default now(),
    "user_id" uuid,
    "encrypted_token" text,
    "token_hash" text,
    "expires_at" timestamp with time zone,
    "updated_at" timestamp with time zone default now(),
    "id" uuid not null default gen_random_uuid()
);


alter table "public"."google_oauth_tokens" enable row level security;

CREATE UNIQUE INDEX google_oauth_tokens_pkey ON public.google_oauth_tokens USING btree (id);

CREATE UNIQUE INDEX google_oauth_tokens_user_id_key ON public.google_oauth_tokens USING btree (user_id);

alter table "public"."google_oauth_tokens" add constraint "google_oauth_tokens_pkey" PRIMARY KEY using index "google_oauth_tokens_pkey";

alter table "public"."google_oauth_tokens" add constraint "google_oauth_tokens_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) not valid;

alter table "public"."google_oauth_tokens" validate constraint "google_oauth_tokens_user_id_fkey";

alter table "public"."google_oauth_tokens" add constraint "google_oauth_tokens_user_id_key" UNIQUE using index "google_oauth_tokens_user_id_key";

grant delete on table "public"."google_oauth_tokens" to "anon";

grant insert on table "public"."google_oauth_tokens" to "anon";

grant references on table "public"."google_oauth_tokens" to "anon";

grant select on table "public"."google_oauth_tokens" to "anon";

grant trigger on table "public"."google_oauth_tokens" to "anon";

grant truncate on table "public"."google_oauth_tokens" to "anon";

grant update on table "public"."google_oauth_tokens" to "anon";

grant delete on table "public"."google_oauth_tokens" to "authenticated";

grant insert on table "public"."google_oauth_tokens" to "authenticated";

grant references on table "public"."google_oauth_tokens" to "authenticated";

grant select on table "public"."google_oauth_tokens" to "authenticated";

grant trigger on table "public"."google_oauth_tokens" to "authenticated";

grant truncate on table "public"."google_oauth_tokens" to "authenticated";

grant update on table "public"."google_oauth_tokens" to "authenticated";

grant delete on table "public"."google_oauth_tokens" to "service_role";

grant insert on table "public"."google_oauth_tokens" to "service_role";

grant references on table "public"."google_oauth_tokens" to "service_role";

grant select on table "public"."google_oauth_tokens" to "service_role";

grant trigger on table "public"."google_oauth_tokens" to "service_role";

grant truncate on table "public"."google_oauth_tokens" to "service_role";

grant update on table "public"."google_oauth_tokens" to "service_role";

create policy "service_role_only"
on "public"."google_oauth_tokens"
as permissive
for all
to service_role
using ((auth.role() = 'service_role'::text))
with check ((auth.role() = 'service_role'::text));



