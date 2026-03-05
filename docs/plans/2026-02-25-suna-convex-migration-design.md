# Suna Monorepo: Upstream Merge + Convex Migration Design

**Date:** 2026-02-25
**Status:** Approved
**Approach:** Big Bang Fork (Option A)

## Summary

Merge all missing upstream Suna features into a Turborepo-based monorepo while replacing Supabase entirely with self-hosted Convex, Better Auth, Convex file storage, and Neo4j for graph memory.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Direction | Port Convex arch INTO upstream | Upstream has 2000+ commits of battle-tested code; our Convex layer is smaller surface area |
| Database | Replace Supabase entirely | Clean architecture, single source of truth |
| Auth | Better Auth + Convex | Already partially implemented in both repos |
| Graph DB | Keep Neo4j | Essential for Cortex Memory SDK relationship storage |
| Python DB access | Convex HTTP API | Cleanest long-term, Convex as single source of truth |
| File storage | Convex file storage | Integrated, simple, eliminates Supabase dependency |

## Target Architecture

### Monorepo Structure (Turborepo)

```
suna-monorepo/
├── apps/
│   ├── api/             # Python FastAPI + Dramatiq workers (uv)
│   ├── web/             # Next.js 16 frontend (pnpm)
│   ├── mobile/          # React Native + Expo (bun)
│   ├── desktop/         # Electron wrapper (pnpm)
│   └── convex/          # Convex backend (bun) - schema, functions, HTTP actions
├── packages/
│   ├── shared/          # @agentpress/shared TypeScript code
│   └── cortex-sdk/      # Cortex Memory SDK (Neo4j graph layer)
├── infrastructure/      # Self-hosted Convex + Neo4j Docker configs
├── infra/               # Pulumi AWS IaC (EKS, Lightsail, monitoring)
├── sdk/                 # Python SDK for programmatic API access
├── setup/               # Interactive setup wizard
├── turbo.json
├── docker-compose.yaml  # Redis + Convex + Neo4j + API + Worker + Frontend
└── package.json         # Root workspace config
```

### Request Flow

```
User (Web/Mobile/Desktop)
    │
    ├── Real-time data ──→ Convex subscriptions (useQuery)
    ├── Auth ──→ Better Auth (Convex backend)
    └── Agent tasks ──→ Next.js → FastAPI → LLM (LiteLLM)
                              │
                              ├── ConvexService (HTTP actions) ──→ Convex DB
                              ├── Redis (Dramatiq queue)
                              ├── Neo4j (Cortex Memory SDK)
                              └── Sandbox (Daytona)
```

### Convex Schema Mapping

```
Supabase Table           → Convex Table          Notes
──────────────────────────────────────────────────────────
accounts (Basejump)      → accounts              Better Auth organization plugin
profiles                 → users                 Better Auth managed
agents                   → agents                Indexed by accountId
threads                  → threads               Indexed by agentId, accountId
messages                 → messages              Indexed by threadId + createdAt
agent_runs               → agentRuns             Indexed by threadId + status
tool_calls               → toolCalls             Embedded or separate table
triggers                 → triggers              Indexed by agentId
trigger_events           → triggerEvents         Indexed by triggerId
oauth_installations      → oauthInstallations    Indexed by triggerId + provider
templates                → templates             Indexed by category
knowledge_base           → knowledgeBase         Indexed by accountId
knowledge_documents      → knowledgeDocuments    Indexed by knowledgeBaseId
billing tables           → billing               Credits, subscriptions, usage
api_keys                 → apiKeys               Indexed by accountId
notifications            → notifications         Indexed by userId + read status
Storage: staged-files    → Convex file storage   storage.generateUploadUrl()
Storage: agentpress      → Convex file storage
Storage: user-avatars    → Convex file storage
```

### Python Backend Integration

ConvexService replaces SupabaseService:

```python
# apps/api/core/services/convex_service.py

class ConvexService:
    """HTTP client wrapping Convex HTTP actions."""

    async def query(self, function_name: str, args: dict) -> Any:
        """Call a Convex query via HTTP action."""

    async def mutation(self, function_name: str, args: dict) -> Any:
        """Call a Convex mutation via HTTP action."""

    async def generate_upload_url(self) -> str:
        """Get a presigned upload URL from Convex file storage."""

    async def get_file_url(self, storage_id: str) -> str:
        """Get a download URL for a stored file."""
```

Convex HTTP actions in `apps/convex/convex/http.ts` expose endpoints:

```
POST /api/query    { function, args, token }
POST /api/mutate   { function, args, token }
POST /api/upload   { token }
GET  /api/file/:id { token }
```

Auth tokens from Better Auth validated per-request in HTTP action handlers.

## Implementation Phases

### Phase 1: Fork & Restructure
- Fork upstream suna at latest commit (6ff052c)
- Restructure: `backend/` → `apps/api/`, keep `apps/frontend/` → rename to `apps/web/`
- Add `turbo.json`, update root package.json with Turbo scripts
- Copy `apps/convex/` workspace from suna-monorepo (Cortex Memory SDK)
- Copy `infrastructure/` from suna-monorepo
- Add Neo4j to docker-compose.yaml
- Verify all upstream features still work unchanged (Supabase still active)
- **Exit criteria:** `turbo run dev` starts all apps, existing tests pass

### Phase 2: Convex Schema & Functions
- Define complete schema in `apps/convex/convex/schema.ts`
- Implement internal queries/mutations for every table
- Implement HTTP actions exposing query/mutate/upload/file endpoints
- Set up Better Auth with Convex (`@convex-dev/better-auth`)
- Implement Convex file storage handlers
- Write vitest tests for all Convex functions
- **Exit criteria:** All Convex functions tested, HTTP actions respond correctly

### Phase 3: Python ConvexService
- Create `ConvexService` in `apps/api/core/services/convex_service.py`
- Match all methods currently on SupabaseService
- Add `USE_CONVEX` feature flag in config.py
- Migrate API routes incrementally: agents → threads → messages → agent_runs → billing → triggers → templates → knowledge_base
- Update Dramatiq worker to use ConvexService
- Run existing pytest suite against Convex backend
- **Exit criteria:** All API endpoints work with `USE_CONVEX=true`, pytest passes

### Phase 4: Frontend Migration
- Replace `@supabase/supabase-js` with `convex/react` hooks
- Replace `backendApi` Supabase-backed calls with direct Convex queries where possible
- Replace Supabase Auth with Better Auth React hooks
- Replace SSE streaming with Convex subscriptions for real-time updates
- Update Zustand stores to use Convex data
- **Exit criteria:** Frontend fully functional without Supabase, all pages render correctly

### Phase 5: Mobile & Desktop
- Replace Supabase client in mobile app with Convex client
- Update auth flow for Better Auth
- Update desktop app API config
- Test all platforms end-to-end
- **Exit criteria:** Mobile and desktop apps authenticate and display data correctly

### Phase 6: Cleanup & Polish
- Remove all Supabase dependencies (Python, JS, env vars)
- Remove `backend/supabase/migrations/` directory
- Update CI/CD workflows for new structure
- Update Python SDK to use Convex endpoints
- Update setup wizard
- Update documentation
- **Exit criteria:** No Supabase references remain, CI green, docs updated

## Risk Mitigation

- **Feature flag** (`USE_CONVEX`) allows instant rollback to Supabase during Phase 3
- **Phase 1 changes nothing** - upstream code works as-is after restructure
- **Each phase is independently deployable** - system stays functional throughout
- **Convex HTTP actions are the integration seam** - Python backend is decoupled from Convex internals

## Missing Features to Gain from Upstream

These come "for free" with the fork:
- Mobile app (React Native + Expo)
- Desktop app (Electron)
- Python SDK
- CI/CD (10 GitHub Actions workflows)
- Pulumi infrastructure (AWS EKS, Lightsail, monitoring)
- Admin APIs (sandbox pool, system status, stress testing)
- Recent tools (composio_upload, spreadsheet, thread_summary)
- Recent features (Excel export, cohort retention, context compression, Redis health)
- Utility modules (file naming, image processing, LLM debugger, lifecycle tracker)
