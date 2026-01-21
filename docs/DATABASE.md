# Database Schema & Supabase Integration

> Detailed documentation of the database schema, Supabase integration, Row Level Security policies, stored functions, and migration workflow.

**Related Documents:** [ARCHITECTURE.md](../ARCHITECTURE.md) | [BACKEND.md](./BACKEND.md) | [API_REFERENCE.md](./API_REFERENCE.md)

---

## Table of Contents

1. [Overview](#overview)
2. [Core Tables](#core-tables)
3. [Table Relationships](#table-relationships)
4. [Row Level Security](#row-level-security)
5. [Stored Functions](#stored-functions)
6. [Storage Buckets](#storage-buckets)
7. [Realtime Subscriptions](#realtime-subscriptions)
8. [Migration Workflow](#migration-workflow)
9. [Client Configuration](#client-configuration)

---

## Overview

**Database:** PostgreSQL via Supabase

**Key Statistics:**
- 80+ tables with RLS enabled
- Multiple storage buckets
- Realtime subscriptions for live updates
- Custom stored functions for complex queries

**Schema Categories:**
- Core: threads, messages, projects, agents
- Auth: via Supabase Auth + basejump extension
- Billing: credit_accounts, credit_ledger, subscriptions
- Features: triggers, credentials, knowledge_base, notifications

---

## Core Tables

### threads

Conversation threads for agent interactions.

```sql
CREATE TABLE threads (
    thread_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES basejump.accounts(id),
    project_id UUID REFERENCES projects(project_id),
    name TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_threads_account_id ON threads(account_id);
CREATE INDEX idx_threads_project_id ON threads(project_id);
CREATE INDEX idx_threads_created_at ON threads(created_at DESC);
```

### messages

Messages within threads (user, assistant, tool).

```sql
CREATE TABLE messages (
    message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
    type TEXT NOT NULL,  -- 'user', 'assistant', 'tool', 'system'
    content TEXT,
    metadata JSONB DEFAULT '{}',
    is_llm_message BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_messages_thread_id ON messages(thread_id);
CREATE INDEX idx_messages_created_at ON messages(thread_id, created_at);
CREATE INDEX idx_messages_type ON messages(type);
```

**Message Types:**
| Type | Description |
|------|-------------|
| `user` | User input messages |
| `assistant` | LLM responses |
| `tool` | Tool execution results |
| `system` | System messages (internal) |

### projects

Project containers with sandbox associations.

```sql
CREATE TABLE projects (
    project_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES basejump.accounts(id),
    name TEXT NOT NULL,
    description TEXT,
    sandbox_id TEXT,  -- Daytona sandbox ID
    resource_external_id TEXT,  -- External resource ID
    resource_config JSONB,  -- Sandbox configuration
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_projects_account_id ON projects(account_id);
CREATE INDEX idx_projects_sandbox_id ON projects(sandbox_id);
```

### agents

Agent configurations with tools and prompts.

```sql
CREATE TABLE agents (
    agent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES basejump.accounts(id),
    name TEXT NOT NULL,
    description TEXT,
    system_prompt TEXT,
    avatar_url TEXT,
    agentpress_tools JSONB DEFAULT '{}',  -- Tool configuration
    custom_mcps JSONB DEFAULT '[]',       -- Custom MCP servers
    configured_mcps JSONB DEFAULT '[]',   -- Pre-configured MCPs
    is_default BOOLEAN DEFAULT FALSE,
    is_public BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_agents_account_id ON agents(account_id);
CREATE INDEX idx_agents_is_default ON agents(is_default);
```

### agent_runs

Agent execution records.

```sql
CREATE TABLE agent_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES threads(thread_id),
    agent_id UUID REFERENCES agents(agent_id),
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, running, completed, stopped, failed
    error TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_agent_runs_thread_id ON agent_runs(thread_id);
CREATE INDEX idx_agent_runs_status ON agent_runs(status);
CREATE INDEX idx_agent_runs_created_at ON agent_runs(created_at DESC);
```

**Status Values:**
| Status | Description |
|--------|-------------|
| `pending` | Queued for execution |
| `running` | Currently executing |
| `completed` | Successfully finished |
| `stopped` | Manually stopped |
| `failed` | Error during execution |

### credit_accounts

User credit balances.

```sql
CREATE TABLE credit_accounts (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id),
    balance DECIMAL(20, 6) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### credit_ledger

Credit transaction history.

```sql
CREATE TABLE credit_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id),
    amount DECIMAL(20, 6) NOT NULL,
    type TEXT NOT NULL,  -- 'usage', 'purchase', 'refund', 'bonus'
    description TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_credit_ledger_user_id ON credit_ledger(user_id);
CREATE INDEX idx_credit_ledger_created_at ON credit_ledger(created_at DESC);
```

### vapi_calls

Voice call records.

```sql
CREATE TABLE vapi_calls (
    call_id TEXT PRIMARY KEY,
    agent_id UUID REFERENCES agents(agent_id),
    thread_id UUID REFERENCES threads(thread_id),
    phone_number TEXT NOT NULL,
    direction TEXT NOT NULL,  -- 'outbound', 'inbound'
    status TEXT NOT NULL,
    transcript JSONB DEFAULT '[]',
    duration_seconds INTEGER,
    cost DECIMAL(10, 4),
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_vapi_calls_thread_id ON vapi_calls(thread_id);
CREATE INDEX idx_vapi_calls_agent_id ON vapi_calls(agent_id);
```

---

## Table Relationships

```
┌──────────────────┐
│  basejump.       │
│  accounts        │
│  (account_id)    │
└────────┬─────────┘
         │
         │ 1:N
         │
    ┌────┴────┬────────────┬────────────┐
    │         │            │            │
    ▼         ▼            ▼            ▼
┌───────┐ ┌───────┐  ┌─────────┐  ┌────────────┐
│threads│ │projects│  │ agents  │  │credit_     │
│       │ │       │  │         │  │accounts    │
└───┬───┘ └───┬───┘  └────┬────┘  └────────────┘
    │         │           │
    │ N:1     │           │
    ├─────────┤           │
    │         │           │
    ▼         ▼           │
┌───────┐                 │
│messages│                │
│       │                 │
└───────┘                 │
    │                     │
    │                     │
┌───▼─────────────────────▼────┐
│         agent_runs            │
│  (thread_id, agent_id)        │
└───────────────────────────────┘
```

### Key Relationships

| Parent | Child | Relationship |
|--------|-------|--------------|
| `basejump.accounts` | `threads` | 1:N (account owns threads) |
| `basejump.accounts` | `projects` | 1:N (account owns projects) |
| `basejump.accounts` | `agents` | 1:N (account owns agents) |
| `threads` | `messages` | 1:N (thread contains messages) |
| `threads` | `agent_runs` | 1:N (thread has runs) |
| `projects` | `threads` | 1:N (project groups threads) |
| `agents` | `agent_runs` | 1:N (agent used in runs) |

---

## Row Level Security

### Common Patterns

#### Account-Based Access

Most tables use account membership for access:

```sql
-- Policy pattern: Account members can access
CREATE POLICY "Account members can access"
ON table_name
FOR ALL
USING (basejump.has_role_on_account(account_id) = true);
```

#### Self-Access Only

For personal data like credits:

```sql
-- Users can only view their own credits
CREATE POLICY "Users view own credits"
ON credit_accounts
FOR SELECT
USING (auth.uid() = user_id);
```

#### Service Role Override

For backend operations:

```sql
-- Service role can manage all records
CREATE POLICY "Service manages all"
ON table_name
FOR ALL
USING (auth.role() = 'service_role');
```

### Table-Specific Policies

#### threads

```sql
-- Users can access threads in their accounts
CREATE POLICY "threads_account_access"
ON threads
FOR ALL
USING (basejump.has_role_on_account(account_id));

-- Service role full access
CREATE POLICY "threads_service_access"
ON threads
FOR ALL
USING (auth.role() = 'service_role');
```

#### messages

```sql
-- Users can access messages in their threads
CREATE POLICY "messages_thread_access"
ON messages
FOR ALL
USING (
    EXISTS (
        SELECT 1 FROM threads
        WHERE threads.thread_id = messages.thread_id
        AND basejump.has_role_on_account(threads.account_id)
    )
);
```

#### agents

```sql
-- Users can access their own agents
CREATE POLICY "agents_owner_access"
ON agents
FOR ALL
USING (basejump.has_role_on_account(account_id));

-- Public agents are readable by all authenticated users
CREATE POLICY "agents_public_read"
ON agents
FOR SELECT
USING (is_public = true AND auth.uid() IS NOT NULL);
```

---

## Stored Functions

### get_llm_formatted_messages

Retrieves messages formatted for LLM consumption with optimizations.

```sql
CREATE OR REPLACE FUNCTION get_llm_formatted_messages(
    p_thread_id UUID,
    p_limit INTEGER DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    result JSONB;
BEGIN
    SELECT jsonb_agg(
        jsonb_build_object(
            'role', CASE
                WHEN type = 'user' THEN 'user'
                WHEN type = 'assistant' THEN 'assistant'
                WHEN type = 'tool' THEN 'tool'
                ELSE type
            END,
            'content', content,
            'metadata', metadata
        )
        ORDER BY created_at
    )
    INTO result
    FROM messages
    WHERE thread_id = p_thread_id
    AND is_llm_message = true
    LIMIT p_limit;

    RETURN COALESCE(result, '[]'::jsonb);
END;
$$;
```

### get_thread_with_project

Fetches thread data with associated project info.

```sql
CREATE OR REPLACE FUNCTION get_thread_with_project(p_thread_id UUID)
RETURNS TABLE(
    thread_id UUID,
    project_id UUID,
    project_name TEXT,
    sandbox_id TEXT,
    account_id UUID
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        t.thread_id,
        t.project_id,
        p.name as project_name,
        p.sandbox_id,
        t.account_id
    FROM threads t
    LEFT JOIN projects p ON t.project_id = p.project_id
    WHERE t.thread_id = p_thread_id;
$$;
```

### deduct_credits

Atomically deducts credits with validation.

```sql
CREATE OR REPLACE FUNCTION deduct_credits(
    p_user_id UUID,
    p_amount DECIMAL,
    p_description TEXT,
    p_metadata JSONB DEFAULT '{}'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    current_balance DECIMAL;
BEGIN
    -- Lock row for update
    SELECT balance INTO current_balance
    FROM credit_accounts
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF current_balance IS NULL OR current_balance < p_amount THEN
        RETURN FALSE;
    END IF;

    -- Update balance
    UPDATE credit_accounts
    SET balance = balance - p_amount,
        updated_at = NOW()
    WHERE user_id = p_user_id;

    -- Record transaction
    INSERT INTO credit_ledger (user_id, amount, type, description, metadata)
    VALUES (p_user_id, -p_amount, 'usage', p_description, p_metadata);

    RETURN TRUE;
END;
$$;
```

---

## Storage Buckets

| Bucket | Purpose | Max Size | Public |
|--------|---------|----------|--------|
| `file-uploads` | User file uploads | 50MB | No |
| `agent-profile-images` | Agent avatars | 5MB | Yes |
| `browser-screenshots` | Browser screenshots | - | No |
| `recordings` | Agent recordings | - | No |
| `knowledge-base` | KB entry files | - | No |

### Bucket Policies

```sql
-- file-uploads: Users can access their own uploads
CREATE POLICY "Users access own uploads"
ON storage.objects
FOR ALL
USING (
    bucket_id = 'file-uploads'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

-- agent-profile-images: Public read, owner write
CREATE POLICY "Public read agent images"
ON storage.objects
FOR SELECT
USING (bucket_id = 'agent-profile-images');

CREATE POLICY "Owner write agent images"
ON storage.objects
FOR INSERT
WITH CHECK (
    bucket_id = 'agent-profile-images'
    AND auth.uid() IS NOT NULL
);
```

---

## Realtime Subscriptions

Enabled tables for live updates:

```sql
-- Enable realtime for projects
ALTER PUBLICATION supabase_realtime ADD TABLE projects;
```

### Frontend Subscription

```typescript
// Subscribe to project changes
const subscription = supabase
  .channel('project-changes')
  .on(
    'postgres_changes',
    {
      event: '*',
      schema: 'public',
      table: 'projects',
      filter: `account_id=eq.${accountId}`,
    },
    (payload) => {
      // Handle change
      console.log('Project changed:', payload);
    }
  )
  .subscribe();
```

---

## Migration Workflow

### Location

**Path:** `backend/supabase/migrations/`

### Naming Convention

```
YYYYMMDDHHMMSS_description.sql
```

Example:
```
20240115120000_add_vapi_calls_table.sql
20240116090000_add_agent_memory_column.sql
```

### Creating Migrations

```bash
# Generate new migration
cd backend
supabase migration new add_feature_name

# This creates: supabase/migrations/YYYYMMDDHHMMSS_add_feature_name.sql
```

### Migration Structure

```sql
-- Migration: add_vapi_calls_table
-- Description: Add table for tracking voice calls

-- Up migration
CREATE TABLE IF NOT EXISTS vapi_calls (
    call_id TEXT PRIMARY KEY,
    -- ... columns
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_vapi_calls_thread_id
ON vapi_calls(thread_id);

-- Enable RLS
ALTER TABLE vapi_calls ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "vapi_calls_account_access"
ON vapi_calls
FOR ALL
USING (
    EXISTS (
        SELECT 1 FROM threads
        WHERE threads.thread_id = vapi_calls.thread_id
        AND basejump.has_role_on_account(threads.account_id)
    )
);
```

### Applying Migrations

```bash
# Local development
supabase db reset  # Resets and applies all migrations

# Production (via Supabase dashboard or CLI)
supabase db push
```

---

## Client Configuration

### Backend (Python)

**File:** `backend/core/services/supabase.py`

```python
from supabase import create_client, AsyncClient

class DBConnection:
    _instance: Optional['DBConnection'] = None
    _client: Optional[AsyncClient] = None

    async def initialize(self):
        self._client = await create_client(
            config.SUPABASE_URL,
            config.SUPABASE_SERVICE_ROLE_KEY,
            options=ClientOptions(
                postgrest_client_timeout=45,
                storage_client_timeout=120,
            )
        )

    @property
    async def client(self) -> AsyncClient:
        if self._client is None:
            await self.initialize()
        return self._client
```

**Connection Pool Settings:**

```python
SUPABASE_MAX_CONNECTIONS = 50
SUPABASE_HTTP2_ENABLED = True
SUPABASE_POOL_TIMEOUT = 45.0  # seconds
```

### Frontend (TypeScript)

**File:** `apps/frontend/src/lib/supabase/client.ts`

```typescript
import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
```

**Server-Side Client:**

**File:** `apps/frontend/src/lib/supabase/server.ts`

```typescript
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export function createClient() {
  const cookieStore = cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        // ... set, remove
      },
    }
  );
}
```

---

## Performance Indexes

### Critical Indexes

```sql
-- Thread lookups by account
CREATE INDEX idx_threads_account_id ON threads(account_id);

-- Message retrieval by thread (ordered)
CREATE INDEX idx_messages_thread_created ON messages(thread_id, created_at);

-- Agent run status queries
CREATE INDEX idx_agent_runs_status ON agent_runs(status)
WHERE status = 'running';

-- Credit balance lookups
CREATE INDEX idx_credit_accounts_user ON credit_accounts(user_id);

-- Project sandbox lookups
CREATE INDEX idx_projects_sandbox ON projects(sandbox_id)
WHERE sandbox_id IS NOT NULL;
```

### Query Optimization Notes

1. **Message Retrieval:** Always filter by `thread_id` first, then order by `created_at`
2. **Running Runs:** Use partial index on `status = 'running'` for active run queries
3. **Credit Checks:** Use `FOR UPDATE` locks during deductions
4. **Thread Lists:** Paginate using `created_at` cursor, not offset

---

## Key File Locations

| Purpose | Path |
|---------|------|
| Migrations | `backend/supabase/migrations/` |
| Supabase Config | `backend/supabase/config.toml` |
| Backend Client | `backend/core/services/supabase.py` |
| Direct Postgres | `backend/core/services/db.py` |
| Frontend Client | `apps/frontend/src/lib/supabase/client.ts` |
| Server Client | `apps/frontend/src/lib/supabase/server.ts` |

---

*For API endpoints that interact with these tables, see [API_REFERENCE.md](./API_REFERENCE.md). For backend service patterns, see [BACKEND.md](./BACKEND.md).*
