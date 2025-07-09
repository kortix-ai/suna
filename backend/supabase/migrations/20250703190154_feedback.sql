create table "public"."feedback" (
    "id" uuid not null default gen_random_uuid(),
    "created_at" timestamp with time zone not null default now(),
    "is_good" boolean not null,
    "message_id" uuid,
    "feedback" text
);


alter table "public"."feedback" enable row level security;

CREATE UNIQUE INDEX feedback_message_id_key ON public.feedback USING btree (message_id);

CREATE UNIQUE INDEX feedback_pkey ON public.feedback USING btree (id);

alter table "public"."feedback" add constraint "feedback_pkey" PRIMARY KEY using index "feedback_pkey";

alter table "public"."feedback" add constraint "feedback_message_id_fkey" FOREIGN KEY (message_id) REFERENCES messages(message_id) not valid;

alter table "public"."feedback" validate constraint "feedback_message_id_fkey";

alter table "public"."feedback" add constraint "feedback_message_id_key" UNIQUE using index "feedback_message_id_key";

grant delete on table "public"."feedback" to "anon";

grant insert on table "public"."feedback" to "anon";

grant references on table "public"."feedback" to "anon";

grant select on table "public"."feedback" to "anon";

grant trigger on table "public"."feedback" to "anon";

grant truncate on table "public"."feedback" to "anon";

grant update on table "public"."feedback" to "anon";

grant delete on table "public"."feedback" to "authenticated";

grant insert on table "public"."feedback" to "authenticated";

grant references on table "public"."feedback" to "authenticated";

grant select on table "public"."feedback" to "authenticated";

grant trigger on table "public"."feedback" to "authenticated";

grant truncate on table "public"."feedback" to "authenticated";

grant update on table "public"."feedback" to "authenticated";

grant delete on table "public"."feedback" to "service_role";

grant insert on table "public"."feedback" to "service_role";

grant references on table "public"."feedback" to "service_role";

grant select on table "public"."feedback" to "service_role";

grant trigger on table "public"."feedback" to "service_role";

grant truncate on table "public"."feedback" to "service_role";

grant update on table "public"."feedback" to "service_role";


