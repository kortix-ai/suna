create extension if not exists "pg_net" with schema "public" version '0.14.0';

alter table "public"."projects" add column "icon_name" text;


