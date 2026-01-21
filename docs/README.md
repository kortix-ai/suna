# SprintLab (Suna) Documentation

> Comprehensive documentation for understanding, developing, and extending the SprintLab/Suna platform.

**Last Updated:** January 2026

---

## Quick Links

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](../ARCHITECTURE.md) | High-level system overview and architecture diagrams |
| [BACKEND.md](./BACKEND.md) | Backend architecture deep-dive (FastAPI, routers, services) |
| [FRONTEND.md](./FRONTEND.md) | Frontend architecture (Next.js, state management, components) |
| [DATABASE.md](./DATABASE.md) | Database schema, Supabase integration, RLS policies |
| [API_REFERENCE.md](./API_REFERENCE.md) | REST API endpoints, authentication, request/response formats |
| [TOOL_IMPLEMENTATION_GUIDE.md](./TOOL_IMPLEMENTATION_GUIDE.md) | Complete guide to implementing new tools |
| [AGENT_ORCHESTRATION.md](./AGENT_ORCHESTRATION.md) | Agent execution lifecycle and orchestration system |
| [STREAMING.md](./STREAMING.md) | Real-time streaming architecture (SSE, Redis) |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Development setup, workflows, and commands |

---

## Documentation Map

```
ARCHITECTURE.md (High-Level Overview)
         │
         ├──► docs/BACKEND.md
         │         │
         │         ├── Entry point (api.py)
         │         ├── Directory structure
         │         ├── Core components
         │         └── Router organization
         │
         ├──► docs/FRONTEND.md
         │         │
         │         ├── Next.js App Router
         │         ├── State management (Zustand)
         │         ├── Tool view system
         │         └── API client patterns
         │
         ├──► docs/DATABASE.md
         │         │
         │         ├── Core tables schema
         │         ├── RLS policies
         │         ├── Stored functions
         │         └── Migration workflow
         │
         ├──► docs/API_REFERENCE.md
         │         │
         │         ├── Authentication
         │         ├── Agent endpoints
         │         ├── Thread endpoints
         │         └── Error handling
         │
         ├──► docs/AGENT_ORCHESTRATION.md
         │         │
         │         ├── Execution lifecycle
         │         ├── AgentRunner
         │         ├── ThreadManager
         │         └── Auto-continue mechanism
         │
         ├──► docs/STREAMING.md
         │         │
         │         ├── Redis streams
         │         ├── SSE architecture
         │         ├── Message types
         │         └── Frontend StreamConnection
         │
         └──► docs/TOOL_IMPLEMENTATION_GUIDE.md
                   │
                   ├── Tool system overview
                   ├── Backend implementation
                   ├── Frontend ToolView
                   └── Complete example
```

---

## Recommended Reading Order

### For New Developers

1. **[ARCHITECTURE.md](../ARCHITECTURE.md)** - Start here for high-level understanding
2. **[DEVELOPMENT.md](./DEVELOPMENT.md)** - Set up your environment
3. **[BACKEND.md](./BACKEND.md)** - Understand the backend structure
4. **[FRONTEND.md](./FRONTEND.md)** - Understand the frontend structure
5. **[AGENT_ORCHESTRATION.md](./AGENT_ORCHESTRATION.md)** - Core agent execution flow

### For Tool Developers

1. **[TOOL_IMPLEMENTATION_GUIDE.md](./TOOL_IMPLEMENTATION_GUIDE.md)** - Complete implementation guide
2. **[BACKEND.md](./BACKEND.md)** - Backend context
3. **[FRONTEND.md](./FRONTEND.md)** - Frontend ToolView patterns

### For API Integrators

1. **[API_REFERENCE.md](./API_REFERENCE.md)** - API endpoints and contracts
2. **[STREAMING.md](./STREAMING.md)** - Real-time streaming integration
3. **[DATABASE.md](./DATABASE.md)** - Data model understanding

### For DevOps/Infrastructure

1. **[DEVELOPMENT.md](./DEVELOPMENT.md)** - Commands and Docker setup
2. **[BACKEND.md](./BACKEND.md)** - Service architecture
3. **[DATABASE.md](./DATABASE.md)** - Database operations
4. **[STREAMING.md](./STREAMING.md)** - Redis integration

---

## Cross-Reference Guide

### Common Tasks

| Task | Relevant Documents |
|------|-------------------|
| Add a new tool | [TOOL_IMPLEMENTATION_GUIDE.md](./TOOL_IMPLEMENTATION_GUIDE.md), [BACKEND.md](./BACKEND.md), [FRONTEND.md](./FRONTEND.md) |
| Add a new API endpoint | [BACKEND.md](./BACKEND.md), [API_REFERENCE.md](./API_REFERENCE.md) |
| Modify agent behavior | [AGENT_ORCHESTRATION.md](./AGENT_ORCHESTRATION.md), [BACKEND.md](./BACKEND.md) |
| Add database table | [DATABASE.md](./DATABASE.md), [DEVELOPMENT.md](./DEVELOPMENT.md) |
| Implement streaming feature | [STREAMING.md](./STREAMING.md), [FRONTEND.md](./FRONTEND.md) |
| Debug agent execution | [AGENT_ORCHESTRATION.md](./AGENT_ORCHESTRATION.md), [STREAMING.md](./STREAMING.md) |
| Set up local development | [DEVELOPMENT.md](./DEVELOPMENT.md) |
| Understand billing/credits | [DATABASE.md](./DATABASE.md), [API_REFERENCE.md](./API_REFERENCE.md) |

### Key Components by Document

| Component | Primary Doc | Related Docs |
|-----------|-------------|--------------|
| ThreadManager | [AGENT_ORCHESTRATION.md](./AGENT_ORCHESTRATION.md) | [BACKEND.md](./BACKEND.md) |
| AgentRunner | [AGENT_ORCHESTRATION.md](./AGENT_ORCHESTRATION.md) | [STREAMING.md](./STREAMING.md) |
| ToolRegistry | [TOOL_IMPLEMENTATION_GUIDE.md](./TOOL_IMPLEMENTATION_GUIDE.md) | [BACKEND.md](./BACKEND.md) |
| StreamConnection | [STREAMING.md](./STREAMING.md) | [FRONTEND.md](./FRONTEND.md) |
| Supabase Client | [DATABASE.md](./DATABASE.md) | [BACKEND.md](./BACKEND.md), [FRONTEND.md](./FRONTEND.md) |
| ToolView Components | [TOOL_IMPLEMENTATION_GUIDE.md](./TOOL_IMPLEMENTATION_GUIDE.md) | [FRONTEND.md](./FRONTEND.md) |

---

## File Locations Quick Reference

### Backend

| Purpose | Path |
|---------|------|
| FastAPI Entry | `backend/api.py` |
| Core Logic | `backend/core/` |
| Tools | `backend/core/tools/` |
| Agent Runner | `backend/core/agents/runner/` |
| AgentPress | `backend/core/agentpress/` |
| Services | `backend/core/services/` |
| Migrations | `backend/supabase/migrations/` |
| Tests | `backend/tests/` |

### Frontend

| Purpose | Path |
|---------|------|
| App Router | `apps/frontend/src/app/` |
| Components | `apps/frontend/src/components/` |
| Tool Views | `apps/frontend/src/components/thread/tool-views/` |
| Stores | `apps/frontend/src/stores/` |
| API Client | `apps/frontend/src/lib/api-client.ts` |
| Streaming | `apps/frontend/src/lib/streaming/` |

### Mobile

| Purpose | Path |
|---------|------|
| Components | `apps/mobile/components/` |
| Tool Views | `apps/mobile/components/chat/tool-views/` |

---

## Contributing to Documentation

When updating documentation:

1. Keep the high-level overview in `ARCHITECTURE.md` concise
2. Add detailed information to the relevant specialized document
3. Update cross-references if adding new sections
4. Include code examples where helpful
5. Document assumptions and limitations

---

*For the most current information, always refer to the source code. This documentation provides context and guidance for understanding the codebase structure.*
