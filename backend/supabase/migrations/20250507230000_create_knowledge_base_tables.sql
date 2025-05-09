-- File: backend/supabase/migrations/YYYYMMDDHHMMSS_create_knowledge_base_tables.sql
-- Replace YYYYMMDDHHMMSS with the actual timestamp of when this migration is created.

-- Ensure the vector extension is enabled (though it's best to enable it via Supabase UI or a separate prior migration if strictly ordered)
-- CREATE EXTENSION IF NOT EXISTS vector;

-- 1. Table for storing metadata about uploaded documents for the knowledge base
CREATE TABLE public.knowledge_base_documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES public.projects(project_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE, -- Assuming you have an accounts table from basejump
    file_name TEXT NOT NULL,
    storage_path TEXT NOT NULL UNIQUE, -- Path in Supabase Storage, e.g., "project_id/file_name.pdf"
    file_size BIGINT,
    mime_type TEXT,
    status TEXT DEFAULT 'pending', -- e.g., 'pending', 'processing', 'indexed', 'failed'
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Indexes for knowledge_base_documents
CREATE INDEX idx_kb_documents_project_id ON public.knowledge_base_documents(project_id);
CREATE INDEX idx_kb_documents_account_id ON public.knowledge_base_documents(account_id);
CREATE INDEX idx_kb_documents_status ON public.knowledge_base_documents(status);

-- RLS (Row Level Security) for knowledge_base_documents
ALTER TABLE public.knowledge_base_documents ENABLE ROW LEVEL SECURITY;

-- Policy: Users can manage (select, insert, update, delete) documents for projects they are members of.
-- Adjust 'basejump.has_role_on_account' and project membership logic as per your existing RLS setup.
-- This is a placeholder; you'll need to adapt it to how you determine project membership and roles.
-- For simplicity, this example assumes account_id on the document matches the user's account_id.
-- A more robust policy would check against a project_members table.

-- Policy per knowledge_base_documents (Riveduta)
-- Nome policy leggermente modificato per chiarezza
DROP POLICY IF EXISTS "Allow full access for account members on their project documents" ON public.knowledge_base_documents;
CREATE POLICY "Allow full access to KB documents for account members"
    ON public.knowledge_base_documents
    FOR ALL -- Permette SELECT, INSERT, UPDATE, DELETE
    USING (
        -- L'utente corrente deve essere un membro (qualsiasi ruolo) dell'account associato a questo documento KB.
        basejump.has_role_on_account(public.knowledge_base_documents.account_id)
    )
    WITH CHECK (
        basejump.has_role_on_account(public.knowledge_base_documents.account_id)
    );


-- 2. Table for storing text chunks and their embeddings
CREATE TABLE public.knowledge_base_chunks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES public.knowledge_base_documents(id) ON DELETE CASCADE,
    chunk_text TEXT NOT NULL,
    embedding vector(1024), -- Dimension for embeddings (e.g., 1024 for intfloat/multilingual-e5-large, 1536 for ada-002). Adjust if using a different model.
    metadata JSONB, -- e.g., page number, chunk number, document source
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Indexes for knowledge_base_chunks
CREATE INDEX idx_kb_chunks_document_id ON public.knowledge_base_chunks(document_id);

-- IVF FLAT index for fast similarity search on embeddings.
-- The number of lists (e.g., 100) depends on the dataset size. Start with sqrt(N) where N is the number of rows.
-- This is an example; you might need to tune it later.
-- CREATE INDEX ON public.knowledge_base_chunks USING ivfflat (embedding vector_l2_ops) WITH (lists = 100); -- Switched to HNSW

-- Alternatively, for smaller datasets or exact search, HNSW can be better:
CREATE INDEX ON public.knowledge_base_chunks USING hnsw (embedding vector_l2_ops);


-- RLS for knowledge_base_chunks
ALTER TABLE public.knowledge_base_chunks ENABLE ROW LEVEL SECURITY;

-- Policy: Users can select chunks belonging to documents they have access to.
-- (Insert/Update/Delete of chunks should ideally be handled by backend/Celery tasks, not directly by users)
-- Policy per knowledge_base_chunks (Riveduta)
-- Nome policy leggermente modificato per chiarezza
DROP POLICY IF EXISTS "Allow read access for account members on chunks of their project documents" ON public.knowledge_base_chunks;
CREATE POLICY "Allow read access to KB chunks for account members"
    ON public.knowledge_base_chunks
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1
            FROM public.knowledge_base_documents kbd
            WHERE kbd.id = public.knowledge_base_chunks.document_id
              -- L'utente corrente deve essere un membro (qualsiasi ruolo) dell'account associato al documento KB genitore.
              AND basejump.has_role_on_account(kbd.account_id)
        )
    );

-- Function to update 'updated_at' timestamp
CREATE OR REPLACE FUNCTION public.trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for knowledge_base_documents
CREATE TRIGGER set_timestamp_knowledge_base_documents
BEFORE UPDATE ON public.knowledge_base_documents
FOR EACH ROW
EXECUTE FUNCTION public.trigger_set_timestamp(); 