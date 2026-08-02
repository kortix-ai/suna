-- Migration: agent_profile_knowledge
-- New tables are empty at creation. Their indexes and foreign keys do not scan
-- or lock an existing populated relation.
set lock_timeout = '2s';
set statement_timeout = '30s';

create extension if not exists vector with schema extensions;

create type kortix.agent_profile_risk as enum ('low', 'medium', 'high');
create type kortix.agent_knowledge_source_type as enum ('upload', 'url', 'connector');
create type kortix.agent_knowledge_source_status as enum (
  'draft', 'pending', 'syncing', 'ready', 'degraded', 'error', 'revoked'
);
create type kortix.agent_knowledge_version_status as enum (
  'processing', 'active', 'failed', 'superseded'
);
create type kortix.agent_knowledge_sync_job_status as enum (
  'pending', 'running', 'succeeded', 'failed', 'dead_lettered'
);

create table kortix.agent_profile_drafts (
  draft_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  project_id uuid not null references kortix.projects(project_id) on delete cascade,
  agent_name varchar(200) not null,
  revision integer not null default 0,
  base_revision text,
  base_sections jsonb not null default '{}'::jsonb,
  sections jsonb not null default '{}'::jsonb,
  section_revisions jsonb not null default '{}'::jsonb,
  changed_sections jsonb not null default '[]'::jsonb,
  changes jsonb not null default '[]'::jsonb,
  impact jsonb not null default '{}'::jsonb,
  highest_risk kortix.agent_profile_risk not null default 'low',
  active_editors jsonb not null default '[]'::jsonb,
  branch_name text,
  change_request_id uuid,
  updated_by uuid not null,
  expires_at timestamptz default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_profile_drafts_sections_object_check check (jsonb_typeof(sections) = 'object'),
  constraint agent_profile_drafts_base_sections_object_check check (jsonb_typeof(base_sections) = 'object'),
  constraint agent_profile_drafts_section_revisions_object_check check (jsonb_typeof(section_revisions) = 'object'),
  constraint agent_profile_drafts_changed_sections_array_check check (jsonb_typeof(changed_sections) = 'array'),
  constraint agent_profile_drafts_changes_array_check check (jsonb_typeof(changes) = 'array'),
  constraint agent_profile_drafts_impact_object_check check (jsonb_typeof(impact) = 'object'),
  constraint agent_profile_drafts_active_editors_array_check check (jsonb_typeof(active_editors) = 'array'),
  constraint agent_profile_drafts_revision_check check (revision >= 0)
);

create unique index idx_agent_profile_drafts_project_agent
  on kortix.agent_profile_drafts(project_id, agent_name);
create index idx_agent_profile_drafts_account
  on kortix.agent_profile_drafts(account_id);
create index idx_agent_profile_drafts_expires
  on kortix.agent_profile_drafts(expires_at);

create table kortix.agent_knowledge_sources (
  source_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  project_id uuid not null references kortix.projects(project_id) on delete cascade,
  agent_name varchar(200) not null,
  slug varchar(200) not null,
  source_type kortix.agent_knowledge_source_type not null,
  title varchar(500) not null,
  privacy varchar(32) not null default 'private',
  status kortix.agent_knowledge_source_status not null default 'draft',
  url text,
  storage_path text,
  connector_profile_id uuid,
  resource_id text,
  source_config jsonb not null default '{}'::jsonb,
  automatic_sync boolean not null default true,
  sync_interval_hours integer default 24,
  active_version_id uuid,
  last_successful_sync_at timestamptz,
  last_sync_attempt_at timestamptz,
  next_sync_at timestamptz,
  last_error text,
  revoked_at timestamptz,
  revoked_by uuid,
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_knowledge_sources_private_check check (privacy = 'private'),
  constraint agent_knowledge_sources_sync_interval_check check (
    sync_interval_hours is null or sync_interval_hours between 1 and 8760
  ),
  constraint agent_knowledge_sources_config_object_check check (jsonb_typeof(source_config) = 'object'),
  constraint agent_knowledge_sources_kind_fields_check check (
    (source_type = 'upload' and storage_path is not null and url is null and connector_profile_id is null)
    or (source_type = 'url' and url is not null and storage_path is null and connector_profile_id is null)
    or (source_type = 'connector' and connector_profile_id is not null and resource_id is not null and url is null and storage_path is null)
  )
);

create unique index idx_agent_knowledge_sources_project_agent_slug
  on kortix.agent_knowledge_sources(project_id, agent_name, slug);
create index idx_agent_knowledge_sources_account
  on kortix.agent_knowledge_sources(account_id);
create index idx_agent_knowledge_sources_sync_due
  on kortix.agent_knowledge_sources(status, next_sync_at);

create table kortix.agent_knowledge_versions (
  version_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  project_id uuid not null references kortix.projects(project_id) on delete cascade,
  agent_name varchar(200) not null,
  source_id uuid not null references kortix.agent_knowledge_sources(source_id) on delete cascade,
  status kortix.agent_knowledge_version_status not null default 'processing',
  content_hash varchar(64),
  chunk_count integer not null default 0,
  embedding_model varchar(200),
  lexical_only boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  error text,
  promoted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint agent_knowledge_versions_chunk_count_check check (chunk_count >= 0),
  constraint agent_knowledge_versions_metadata_object_check check (jsonb_typeof(metadata) = 'object')
);

create index idx_agent_knowledge_versions_project_agent
  on kortix.agent_knowledge_versions(project_id, agent_name);
create index idx_agent_knowledge_versions_source_created
  on kortix.agent_knowledge_versions(source_id, created_at);

alter table kortix.agent_knowledge_sources
  add constraint agent_knowledge_sources_active_version_fk
  foreign key (active_version_id)
  references kortix.agent_knowledge_versions(version_id)
  on delete set null;

create table kortix.agent_knowledge_chunks (
  chunk_id uuid primary key default gen_random_uuid(),
  citation_id uuid not null default gen_random_uuid(),
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  project_id uuid not null references kortix.projects(project_id) on delete cascade,
  agent_name varchar(200) not null,
  source_id uuid not null references kortix.agent_knowledge_sources(source_id) on delete cascade,
  version_id uuid not null references kortix.agent_knowledge_versions(version_id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  token_count integer not null,
  locator jsonb not null default '{}'::jsonb,
  search_document tsvector generated always as (
    to_tsvector('english', coalesce(content, ''))
  ) stored,
  embedding extensions.vector(1536),
  created_at timestamptz not null default now(),
  constraint agent_knowledge_chunks_token_count_check check (token_count > 0),
  constraint agent_knowledge_chunks_locator_object_check check (jsonb_typeof(locator) = 'object')
);

create unique index idx_agent_knowledge_chunks_citation
  on kortix.agent_knowledge_chunks(citation_id);
create unique index idx_agent_knowledge_chunks_version_index
  on kortix.agent_knowledge_chunks(version_id, chunk_index);
create index idx_agent_knowledge_chunks_agent_source
  on kortix.agent_knowledge_chunks(project_id, agent_name, source_id);
create index idx_agent_knowledge_chunks_search
  on kortix.agent_knowledge_chunks using gin(search_document);
create index idx_agent_knowledge_chunks_embedding
  on kortix.agent_knowledge_chunks using hnsw(embedding vector_cosine_ops)
  where embedding is not null;

create table kortix.agent_knowledge_sync_jobs (
  job_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  project_id uuid not null references kortix.projects(project_id) on delete cascade,
  agent_name varchar(200) not null,
  source_id uuid not null references kortix.agent_knowledge_sources(source_id) on delete cascade,
  status kortix.agent_knowledge_sync_job_status not null default 'pending',
  attempt integer not null default 0,
  max_attempts integer not null default 5,
  available_at timestamptz not null default now(),
  lease_owner varchar(200),
  lease_until timestamptz,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_knowledge_sync_jobs_attempt_check check (attempt between 0 and max_attempts)
);

create index idx_agent_knowledge_sync_jobs_available
  on kortix.agent_knowledge_sync_jobs(status, available_at, lease_until);
create index idx_agent_knowledge_sync_jobs_source
  on kortix.agent_knowledge_sync_jobs(source_id, created_at);
create unique index idx_agent_knowledge_sync_jobs_one_active
  on kortix.agent_knowledge_sync_jobs(source_id)
  where status in ('pending', 'running');

create table kortix.agent_knowledge_assignments (
  assignment_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  project_id uuid not null references kortix.projects(project_id) on delete cascade,
  agent_name varchar(200) not null,
  source_id uuid not null references kortix.agent_knowledge_sources(source_id) on delete cascade,
  manifest_revision varchar(64) not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index idx_agent_knowledge_assignments_project_agent_source
  on kortix.agent_knowledge_assignments(project_id, agent_name, source_id);
create index idx_agent_knowledge_assignments_source
  on kortix.agent_knowledge_assignments(source_id);

create table kortix.agent_profile_test_sessions (
  session_id text primary key references kortix.project_sessions(session_id) on delete cascade,
  account_id uuid not null references kortix.accounts(account_id) on delete cascade,
  project_id uuid not null references kortix.projects(project_id) on delete cascade,
  agent_name varchar(200) not null,
  draft_revision integer not null,
  branch_name text not null,
  source_ids uuid[] not null default '{}',
  excluded_integrations text[] not null default '{}',
  created_by uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint agent_profile_test_sessions_revision_check check (draft_revision > 0)
);

create index idx_agent_profile_test_sessions_project_agent
  on kortix.agent_profile_test_sessions(project_id, agent_name);
create index idx_agent_profile_test_sessions_expires
  on kortix.agent_profile_test_sessions(expires_at);

alter table kortix.agent_profile_drafts enable row level security;
alter table kortix.agent_knowledge_sources enable row level security;
alter table kortix.agent_knowledge_versions enable row level security;
alter table kortix.agent_knowledge_chunks enable row level security;
alter table kortix.agent_knowledge_sync_jobs enable row level security;
alter table kortix.agent_knowledge_assignments enable row level security;
alter table kortix.agent_profile_test_sessions enable row level security;

create policy agent_profile_drafts_project_members
  on kortix.agent_profile_drafts for all
  using (exists (
    select 1 from kortix.project_members pm
    where pm.project_id = agent_profile_drafts.project_id and pm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from kortix.project_members pm
    where pm.project_id = agent_profile_drafts.project_id and pm.user_id = auth.uid()
  ));

create policy agent_knowledge_sources_project_members
  on kortix.agent_knowledge_sources for all
  using (exists (
    select 1 from kortix.project_members pm
    where pm.project_id = agent_knowledge_sources.project_id and pm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from kortix.project_members pm
    where pm.project_id = agent_knowledge_sources.project_id and pm.user_id = auth.uid()
  ));

create policy agent_knowledge_versions_project_members
  on kortix.agent_knowledge_versions for all
  using (exists (
    select 1 from kortix.project_members pm
    where pm.project_id = agent_knowledge_versions.project_id and pm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from kortix.project_members pm
    where pm.project_id = agent_knowledge_versions.project_id and pm.user_id = auth.uid()
  ));

create policy agent_knowledge_chunks_project_members
  on kortix.agent_knowledge_chunks for all
  using (exists (
    select 1 from kortix.project_members pm
    where pm.project_id = agent_knowledge_chunks.project_id and pm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from kortix.project_members pm
    where pm.project_id = agent_knowledge_chunks.project_id and pm.user_id = auth.uid()
  ));

create policy agent_knowledge_sync_jobs_project_members
  on kortix.agent_knowledge_sync_jobs for all
  using (exists (
    select 1 from kortix.project_members pm
    where pm.project_id = agent_knowledge_sync_jobs.project_id and pm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from kortix.project_members pm
    where pm.project_id = agent_knowledge_sync_jobs.project_id and pm.user_id = auth.uid()
  ));

create policy agent_knowledge_assignments_project_members
  on kortix.agent_knowledge_assignments for all
  using (exists (
    select 1 from kortix.project_members pm
    where pm.project_id = agent_knowledge_assignments.project_id and pm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from kortix.project_members pm
    where pm.project_id = agent_knowledge_assignments.project_id and pm.user_id = auth.uid()
  ));

create policy agent_profile_test_sessions_project_members
  on kortix.agent_profile_test_sessions for all
  using (exists (
    select 1 from kortix.project_members pm
    where pm.project_id = agent_profile_test_sessions.project_id and pm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from kortix.project_members pm
    where pm.project_id = agent_profile_test_sessions.project_id and pm.user_id = auth.uid()
  ));

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'agent-knowledge',
  'agent-knowledge',
  false,
  52428800,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
    'text/csv',
    'text/html'
  ]::text[]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
