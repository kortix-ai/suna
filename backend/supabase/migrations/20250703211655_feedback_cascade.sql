drop trigger if exists "trigger_agent_kb_entries_calculate_tokens" on "public"."agent_knowledge_base_entries";

drop trigger if exists "trigger_agent_kb_entries_updated_at" on "public"."agent_knowledge_base_entries";

drop trigger if exists "update_agent_triggers_updated_at" on "public"."agent_triggers";

drop trigger if exists "update_custom_trigger_providers_updated_at" on "public"."custom_trigger_providers";

drop trigger if exists "update_oauth_installations_updated_at" on "public"."oauth_installations";

drop policy "agent_kb_jobs_user_access" on "public"."agent_kb_file_processing_jobs";

drop policy "agent_kb_entries_user_access" on "public"."agent_knowledge_base_entries";

drop policy "agent_kb_usage_log_user_access" on "public"."agent_knowledge_base_usage_log";

drop policy "agent_triggers_delete_policy" on "public"."agent_triggers";

drop policy "agent_triggers_insert_policy" on "public"."agent_triggers";

drop policy "agent_triggers_select_policy" on "public"."agent_triggers";

drop policy "agent_triggers_update_policy" on "public"."agent_triggers";

drop policy "custom_trigger_providers_delete_policy" on "public"."custom_trigger_providers";

drop policy "custom_trigger_providers_insert_policy" on "public"."custom_trigger_providers";

drop policy "custom_trigger_providers_select_policy" on "public"."custom_trigger_providers";

drop policy "custom_trigger_providers_update_policy" on "public"."custom_trigger_providers";

drop policy "oauth_installations_delete_policy" on "public"."oauth_installations";

drop policy "oauth_installations_insert_policy" on "public"."oauth_installations";

drop policy "oauth_installations_select_policy" on "public"."oauth_installations";

drop policy "oauth_installations_update_policy" on "public"."oauth_installations";

drop policy "trigger_events_insert_policy" on "public"."trigger_events";

drop policy "trigger_events_select_policy" on "public"."trigger_events";

revoke delete on table "public"."agent_kb_file_processing_jobs" from "anon";

revoke insert on table "public"."agent_kb_file_processing_jobs" from "anon";

revoke references on table "public"."agent_kb_file_processing_jobs" from "anon";

revoke select on table "public"."agent_kb_file_processing_jobs" from "anon";

revoke trigger on table "public"."agent_kb_file_processing_jobs" from "anon";

revoke truncate on table "public"."agent_kb_file_processing_jobs" from "anon";

revoke update on table "public"."agent_kb_file_processing_jobs" from "anon";

revoke delete on table "public"."agent_kb_file_processing_jobs" from "authenticated";

revoke insert on table "public"."agent_kb_file_processing_jobs" from "authenticated";

revoke references on table "public"."agent_kb_file_processing_jobs" from "authenticated";

revoke select on table "public"."agent_kb_file_processing_jobs" from "authenticated";

revoke trigger on table "public"."agent_kb_file_processing_jobs" from "authenticated";

revoke truncate on table "public"."agent_kb_file_processing_jobs" from "authenticated";

revoke update on table "public"."agent_kb_file_processing_jobs" from "authenticated";

revoke delete on table "public"."agent_kb_file_processing_jobs" from "service_role";

revoke insert on table "public"."agent_kb_file_processing_jobs" from "service_role";

revoke references on table "public"."agent_kb_file_processing_jobs" from "service_role";

revoke select on table "public"."agent_kb_file_processing_jobs" from "service_role";

revoke trigger on table "public"."agent_kb_file_processing_jobs" from "service_role";

revoke truncate on table "public"."agent_kb_file_processing_jobs" from "service_role";

revoke update on table "public"."agent_kb_file_processing_jobs" from "service_role";

revoke delete on table "public"."agent_knowledge_base_entries" from "anon";

revoke insert on table "public"."agent_knowledge_base_entries" from "anon";

revoke references on table "public"."agent_knowledge_base_entries" from "anon";

revoke select on table "public"."agent_knowledge_base_entries" from "anon";

revoke trigger on table "public"."agent_knowledge_base_entries" from "anon";

revoke truncate on table "public"."agent_knowledge_base_entries" from "anon";

revoke update on table "public"."agent_knowledge_base_entries" from "anon";

revoke delete on table "public"."agent_knowledge_base_entries" from "authenticated";

revoke insert on table "public"."agent_knowledge_base_entries" from "authenticated";

revoke references on table "public"."agent_knowledge_base_entries" from "authenticated";

revoke select on table "public"."agent_knowledge_base_entries" from "authenticated";

revoke trigger on table "public"."agent_knowledge_base_entries" from "authenticated";

revoke truncate on table "public"."agent_knowledge_base_entries" from "authenticated";

revoke update on table "public"."agent_knowledge_base_entries" from "authenticated";

revoke delete on table "public"."agent_knowledge_base_entries" from "service_role";

revoke insert on table "public"."agent_knowledge_base_entries" from "service_role";

revoke references on table "public"."agent_knowledge_base_entries" from "service_role";

revoke select on table "public"."agent_knowledge_base_entries" from "service_role";

revoke trigger on table "public"."agent_knowledge_base_entries" from "service_role";

revoke truncate on table "public"."agent_knowledge_base_entries" from "service_role";

revoke update on table "public"."agent_knowledge_base_entries" from "service_role";

revoke delete on table "public"."agent_knowledge_base_usage_log" from "anon";

revoke insert on table "public"."agent_knowledge_base_usage_log" from "anon";

revoke references on table "public"."agent_knowledge_base_usage_log" from "anon";

revoke select on table "public"."agent_knowledge_base_usage_log" from "anon";

revoke trigger on table "public"."agent_knowledge_base_usage_log" from "anon";

revoke truncate on table "public"."agent_knowledge_base_usage_log" from "anon";

revoke update on table "public"."agent_knowledge_base_usage_log" from "anon";

revoke delete on table "public"."agent_knowledge_base_usage_log" from "authenticated";

revoke insert on table "public"."agent_knowledge_base_usage_log" from "authenticated";

revoke references on table "public"."agent_knowledge_base_usage_log" from "authenticated";

revoke select on table "public"."agent_knowledge_base_usage_log" from "authenticated";

revoke trigger on table "public"."agent_knowledge_base_usage_log" from "authenticated";

revoke truncate on table "public"."agent_knowledge_base_usage_log" from "authenticated";

revoke update on table "public"."agent_knowledge_base_usage_log" from "authenticated";

revoke delete on table "public"."agent_knowledge_base_usage_log" from "service_role";

revoke insert on table "public"."agent_knowledge_base_usage_log" from "service_role";

revoke references on table "public"."agent_knowledge_base_usage_log" from "service_role";

revoke select on table "public"."agent_knowledge_base_usage_log" from "service_role";

revoke trigger on table "public"."agent_knowledge_base_usage_log" from "service_role";

revoke truncate on table "public"."agent_knowledge_base_usage_log" from "service_role";

revoke update on table "public"."agent_knowledge_base_usage_log" from "service_role";

revoke delete on table "public"."agent_triggers" from "anon";

revoke insert on table "public"."agent_triggers" from "anon";

revoke references on table "public"."agent_triggers" from "anon";

revoke select on table "public"."agent_triggers" from "anon";

revoke trigger on table "public"."agent_triggers" from "anon";

revoke truncate on table "public"."agent_triggers" from "anon";

revoke update on table "public"."agent_triggers" from "anon";

revoke delete on table "public"."agent_triggers" from "authenticated";

revoke insert on table "public"."agent_triggers" from "authenticated";

revoke references on table "public"."agent_triggers" from "authenticated";

revoke select on table "public"."agent_triggers" from "authenticated";

revoke trigger on table "public"."agent_triggers" from "authenticated";

revoke truncate on table "public"."agent_triggers" from "authenticated";

revoke update on table "public"."agent_triggers" from "authenticated";

revoke delete on table "public"."agent_triggers" from "service_role";

revoke insert on table "public"."agent_triggers" from "service_role";

revoke references on table "public"."agent_triggers" from "service_role";

revoke select on table "public"."agent_triggers" from "service_role";

revoke trigger on table "public"."agent_triggers" from "service_role";

revoke truncate on table "public"."agent_triggers" from "service_role";

revoke update on table "public"."agent_triggers" from "service_role";

revoke delete on table "public"."custom_trigger_providers" from "anon";

revoke insert on table "public"."custom_trigger_providers" from "anon";

revoke references on table "public"."custom_trigger_providers" from "anon";

revoke select on table "public"."custom_trigger_providers" from "anon";

revoke trigger on table "public"."custom_trigger_providers" from "anon";

revoke truncate on table "public"."custom_trigger_providers" from "anon";

revoke update on table "public"."custom_trigger_providers" from "anon";

revoke delete on table "public"."custom_trigger_providers" from "authenticated";

revoke insert on table "public"."custom_trigger_providers" from "authenticated";

revoke references on table "public"."custom_trigger_providers" from "authenticated";

revoke select on table "public"."custom_trigger_providers" from "authenticated";

revoke trigger on table "public"."custom_trigger_providers" from "authenticated";

revoke truncate on table "public"."custom_trigger_providers" from "authenticated";

revoke update on table "public"."custom_trigger_providers" from "authenticated";

revoke delete on table "public"."custom_trigger_providers" from "service_role";

revoke insert on table "public"."custom_trigger_providers" from "service_role";

revoke references on table "public"."custom_trigger_providers" from "service_role";

revoke select on table "public"."custom_trigger_providers" from "service_role";

revoke trigger on table "public"."custom_trigger_providers" from "service_role";

revoke truncate on table "public"."custom_trigger_providers" from "service_role";

revoke update on table "public"."custom_trigger_providers" from "service_role";

revoke delete on table "public"."oauth_installations" from "anon";

revoke insert on table "public"."oauth_installations" from "anon";

revoke references on table "public"."oauth_installations" from "anon";

revoke select on table "public"."oauth_installations" from "anon";

revoke trigger on table "public"."oauth_installations" from "anon";

revoke truncate on table "public"."oauth_installations" from "anon";

revoke update on table "public"."oauth_installations" from "anon";

revoke delete on table "public"."oauth_installations" from "authenticated";

revoke insert on table "public"."oauth_installations" from "authenticated";

revoke references on table "public"."oauth_installations" from "authenticated";

revoke select on table "public"."oauth_installations" from "authenticated";

revoke trigger on table "public"."oauth_installations" from "authenticated";

revoke truncate on table "public"."oauth_installations" from "authenticated";

revoke update on table "public"."oauth_installations" from "authenticated";

revoke delete on table "public"."oauth_installations" from "service_role";

revoke insert on table "public"."oauth_installations" from "service_role";

revoke references on table "public"."oauth_installations" from "service_role";

revoke select on table "public"."oauth_installations" from "service_role";

revoke trigger on table "public"."oauth_installations" from "service_role";

revoke truncate on table "public"."oauth_installations" from "service_role";

revoke update on table "public"."oauth_installations" from "service_role";

revoke delete on table "public"."trigger_events" from "anon";

revoke insert on table "public"."trigger_events" from "anon";

revoke references on table "public"."trigger_events" from "anon";

revoke select on table "public"."trigger_events" from "anon";

revoke trigger on table "public"."trigger_events" from "anon";

revoke truncate on table "public"."trigger_events" from "anon";

revoke update on table "public"."trigger_events" from "anon";

revoke delete on table "public"."trigger_events" from "authenticated";

revoke insert on table "public"."trigger_events" from "authenticated";

revoke references on table "public"."trigger_events" from "authenticated";

revoke select on table "public"."trigger_events" from "authenticated";

revoke trigger on table "public"."trigger_events" from "authenticated";

revoke truncate on table "public"."trigger_events" from "authenticated";

revoke update on table "public"."trigger_events" from "authenticated";

revoke delete on table "public"."trigger_events" from "service_role";

revoke insert on table "public"."trigger_events" from "service_role";

revoke references on table "public"."trigger_events" from "service_role";

revoke select on table "public"."trigger_events" from "service_role";

revoke trigger on table "public"."trigger_events" from "service_role";

revoke truncate on table "public"."trigger_events" from "service_role";

revoke update on table "public"."trigger_events" from "service_role";

alter table "public"."agent_kb_file_processing_jobs" drop constraint "agent_kb_file_processing_jobs_account_id_fkey";

alter table "public"."agent_kb_file_processing_jobs" drop constraint "agent_kb_file_processing_jobs_agent_id_fkey";

alter table "public"."agent_kb_file_processing_jobs" drop constraint "agent_kb_file_processing_jobs_job_type_check";

alter table "public"."agent_kb_file_processing_jobs" drop constraint "agent_kb_file_processing_jobs_status_check";

alter table "public"."agent_knowledge_base_entries" drop constraint "agent_kb_entries_content_not_empty";

alter table "public"."agent_knowledge_base_entries" drop constraint "agent_kb_entries_valid_usage_context";

alter table "public"."agent_knowledge_base_entries" drop constraint "agent_knowledge_base_entries_account_id_fkey";

alter table "public"."agent_knowledge_base_entries" drop constraint "agent_knowledge_base_entries_agent_id_fkey";

alter table "public"."agent_knowledge_base_entries" drop constraint "agent_knowledge_base_entries_extracted_from_zip_id_fkey";

alter table "public"."agent_knowledge_base_entries" drop constraint "agent_knowledge_base_entries_source_type_check";

alter table "public"."agent_knowledge_base_usage_log" drop constraint "agent_knowledge_base_usage_log_agent_id_fkey";

alter table "public"."agent_knowledge_base_usage_log" drop constraint "agent_knowledge_base_usage_log_entry_id_fkey";

alter table "public"."agent_triggers" drop constraint "agent_triggers_agent_id_fkey";

alter table "public"."custom_trigger_providers" drop constraint "custom_trigger_providers_created_by_fkey";

alter table "public"."oauth_installations" drop constraint "oauth_installations_trigger_id_fkey";

alter table "public"."trigger_events" drop constraint "trigger_events_agent_id_fkey";

alter table "public"."trigger_events" drop constraint "trigger_events_trigger_id_fkey";

drop function if exists "public"."calculate_agent_kb_entry_tokens"();

drop function if exists "public"."create_agent_kb_processing_job"(p_agent_id uuid, p_account_id uuid, p_job_type character varying, p_source_info jsonb);

drop function if exists "public"."get_agent_kb_processing_jobs"(p_agent_id uuid, p_limit integer);

drop function if exists "public"."get_agent_knowledge_base"(p_agent_id uuid, p_include_inactive boolean);

drop function if exists "public"."get_agent_knowledge_base_context"(p_agent_id uuid, p_max_tokens integer);

drop function if exists "public"."get_combined_knowledge_base_context"(p_thread_id uuid, p_agent_id uuid, p_max_tokens integer);

drop function if exists "public"."update_agent_kb_entry_timestamp"();

drop function if exists "public"."update_agent_kb_job_status"(p_job_id uuid, p_status character varying, p_result_info jsonb, p_entries_created integer, p_total_files integer, p_error_message text);

alter table "public"."agent_kb_file_processing_jobs" drop constraint "agent_kb_file_processing_jobs_pkey";

alter table "public"."agent_knowledge_base_entries" drop constraint "agent_knowledge_base_entries_pkey";

alter table "public"."agent_knowledge_base_usage_log" drop constraint "agent_knowledge_base_usage_log_pkey";

alter table "public"."agent_triggers" drop constraint "agent_triggers_pkey";

alter table "public"."custom_trigger_providers" drop constraint "custom_trigger_providers_pkey";

alter table "public"."oauth_installations" drop constraint "oauth_installations_pkey";

alter table "public"."trigger_events" drop constraint "trigger_events_pkey";

drop index if exists "public"."agent_kb_file_processing_jobs_pkey";

drop index if exists "public"."agent_knowledge_base_entries_pkey";

drop index if exists "public"."agent_knowledge_base_usage_log_pkey";

drop index if exists "public"."agent_triggers_pkey";

drop index if exists "public"."custom_trigger_providers_pkey";

drop index if exists "public"."idx_agent_kb_entries_account_id";

drop index if exists "public"."idx_agent_kb_entries_agent_id";

drop index if exists "public"."idx_agent_kb_entries_created_at";

drop index if exists "public"."idx_agent_kb_entries_extracted_from_zip";

drop index if exists "public"."idx_agent_kb_entries_is_active";

drop index if exists "public"."idx_agent_kb_entries_source_type";

drop index if exists "public"."idx_agent_kb_entries_usage_context";

drop index if exists "public"."idx_agent_kb_jobs_agent_id";

drop index if exists "public"."idx_agent_kb_jobs_created_at";

drop index if exists "public"."idx_agent_kb_jobs_status";

drop index if exists "public"."idx_agent_kb_usage_agent_id";

drop index if exists "public"."idx_agent_kb_usage_entry_id";

drop index if exists "public"."idx_agent_kb_usage_used_at";

drop index if exists "public"."idx_agent_triggers_agent_id";

drop index if exists "public"."idx_agent_triggers_created_at";

drop index if exists "public"."idx_agent_triggers_is_active";

drop index if exists "public"."idx_agent_triggers_trigger_type";

drop index if exists "public"."idx_custom_trigger_providers_is_active";

drop index if exists "public"."idx_custom_trigger_providers_trigger_type";

drop index if exists "public"."idx_oauth_installations_installed_at";

drop index if exists "public"."idx_oauth_installations_provider";

drop index if exists "public"."idx_oauth_installations_trigger_id";

drop index if exists "public"."idx_trigger_events_agent_id";

drop index if exists "public"."idx_trigger_events_success";

drop index if exists "public"."idx_trigger_events_timestamp";

drop index if exists "public"."idx_trigger_events_trigger_id";

drop index if exists "public"."oauth_installations_pkey";

drop index if exists "public"."trigger_events_pkey";

drop table "public"."agent_kb_file_processing_jobs";

drop table "public"."agent_knowledge_base_entries";

drop table "public"."agent_knowledge_base_usage_log";

drop table "public"."agent_triggers";

drop table "public"."custom_trigger_providers";

drop table "public"."oauth_installations";

drop table "public"."trigger_events";

drop type "public"."agent_trigger_type";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = TIMEZONE('utc'::text, NOW());
    RETURN NEW;
END;
$function$
;


