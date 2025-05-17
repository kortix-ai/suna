-- Enable the vector extension if not already enabled
create extension if not exists vector;

-- Create the memories table
create table if not exists public.memories (
    memory_id uuid primary key default gen_random_uuid(),
    thread_id uuid not null references public.threads(thread_id) on delete cascade,
    memory_type text not null check (memory_type in ('episodic', 'semantic', 'procedural')),
    content text not null,
    embedding vector(1536),
    metadata jsonb default '{}'::jsonb,
    created_at timestamptz default now(),
    last_accessed timestamptz default now(),
    importance_score float default 0.5 check (importance_score >= 0 and importance_score <= 1),
    tags text[] default '{}'::text[]
);

-- Create indexes for efficient querying
create index if not exists memories_thread_id_idx on public.memories(thread_id);
create index if not exists memories_memory_type_idx on public.memories(memory_type);
create index if not exists memories_tags_idx on public.memories using gin(tags);
create index if not exists memories_embedding_idx on public.memories using ivfflat (embedding vector_cosine_ops);

-- Create a function for semantic search
create or replace function match_memories(
    query_embedding vector(1536),
    match_threshold float,
    match_count int
)
returns table (
    memory_id uuid,
    thread_id uuid,
    memory_type text,
    content text,
    embedding vector(1536),
    metadata jsonb,
    created_at timestamptz,
    last_accessed timestamptz,
    importance_score float,
    tags text[],
    similarity float
)
language plpgsql
as $$
begin
    return query
    select
        memories.*,
        1 - (memories.embedding <=> query_embedding) as similarity
    from memories
    where 1 - (memories.embedding <=> query_embedding) > match_threshold
    order by memories.embedding <=> query_embedding
    limit match_count;
end;
$$;

-- Set up RLS policies
alter table public.memories enable row level security;

-- Allow users to see memories from threads they have access to
create policy "Users can view memories from their threads"
    on public.memories for select
    using (
        exists (
            select 1 from public.threads t
            join public.projects p on t.project_id = p.project_id
            join basejump.accounts a on p.account_id = a.id
            join basejump.account_user au on a.id = au.account_id
            where t.thread_id = memories.thread_id
            and au.user_id = auth.uid()
        )
    );

-- Allow users to insert memories for threads they have access to
create policy "Users can insert memories for their threads"
    on public.memories for insert
    with check (
        exists (
            select 1 from public.threads t
            join public.projects p on t.project_id = p.project_id
            join basejump.accounts a on p.account_id = a.id
            join basejump.account_user au on a.id = au.account_id
            where t.thread_id = memories.thread_id
            and au.user_id = auth.uid()
        )
    );

-- Allow users to update memories from threads they have access to
create policy "Users can update memories from their threads"
    on public.memories for update
    using (
        exists (
            select 1 from public.threads t
            join public.projects p on t.project_id = p.project_id
            join basejump.accounts a on p.account_id = a.id
            join basejump.account_user au on a.id = au.account_id
            where t.thread_id = memories.thread_id
            and au.user_id = auth.uid()
        )
    );

-- Allow users to delete memories from threads they have access to
create policy "Users can delete memories from their threads"
    on public.memories for delete
    using (
        exists (
            select 1 from public.threads t
            join public.projects p on t.project_id = p.project_id
            join basejump.accounts a on p.account_id = a.id
            join basejump.account_user au on a.id = au.account_id
            where t.thread_id = memories.thread_id
            and au.user_id = auth.uid()
        )
    );

-- Add trigger to update last_accessed timestamp
create or replace function update_memory_last_accessed()
returns trigger as $$
begin
    new.last_accessed = now();
    return new;
end;
$$ language plpgsql;

create trigger update_memory_last_accessed_trigger
    before update on public.memories
    for each row
    execute function update_memory_last_accessed(); 