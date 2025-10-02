<!--
SYNC IMPACT REPORT
Version change: none → 1.0.0
Modified principles: N/A (initial constitution)
Added sections:
  - Core Principles (5 principles)
  - Security & Compliance
  - Development Workflow
  - Governance
Templates requiring updates:
  ✅ plan-template.md - updated Constitution Check section with concrete gates
  ✅ spec-template.md - reviewed, compatible (no changes required)
  ✅ tasks-template.md - reviewed, compatible (TDD enforcement already present)
Follow-up TODOs: None
-->

# Kortix Platform Constitution

## Core Principles

### I. Agent Safety & Isolation

All agent code execution MUST occur within isolated Docker containers managed by Daytona. Direct execution of untrusted agent code on host systems is strictly prohibited. Each agent instance MUST have its own sandboxed environment with controlled resource limits. Container snapshots MUST be versioned and reproducible (e.g., kortix/suna:0.1.3.20).

**Rationale**: AI agents execute arbitrary code based on LLM outputs. Without strict isolation, a malicious or hallucinated instruction could compromise the host system, access sensitive data, or interfere with other agents. Docker sandboxing provides process isolation, filesystem boundaries, and resource controls that are essential for secure agent operations.

### II. Test-Driven Development (TDD)

Tests MUST be written before implementation. The development cycle is: write test → verify test fails → implement feature → verify test passes → refactor. Contract tests are required for all API endpoints. Integration tests are required for agent workflows and cross-service interactions. Unit tests are required for business logic and validation. Tests MUST be organized with pytest markers (@pytest.mark.unit, @pytest.mark.integration, @pytest.mark.llm) and live in tests/ subdirectories within modules.

**Rationale**: The platform orchestrates complex interactions between LLMs, tools, databases, and sandboxes. Without TDD, regressions in agent behavior, tool integration, or API contracts can silently break production workflows. Tests serve as executable specifications and prevent deployment of broken features. The marker system allows fast feedback loops (unit tests) while preserving comprehensive validation (integration/LLM tests).

### III. Multi-Tenancy & Data Isolation

All database schemas MUST support multi-tenancy through the basejump pattern. User data, agent configurations, and conversation threads MUST be scoped to account IDs. Cross-account data access is strictly prohibited except through explicitly authorized sharing mechanisms. Supabase Row Level Security (RLS) policies MUST enforce tenant boundaries at the database layer.

**Rationale**: Kortix is designed for multiple users and teams. Without strict data isolation, a bug in application code or a compromised account could expose private agent configurations, conversation histories, or sensitive data from other tenants. Database-level RLS provides defense-in-depth beyond application logic.

### IV. LLM Provider Abstraction

All LLM API calls MUST go through the unified LiteLLM interface (core.services.llm.make_llm_api_call()). Direct calls to Anthropic, OpenAI, or other provider SDKs are prohibited. Provider-specific features (e.g., Anthropic prompt caching) MUST be abstracted through LiteLLM's interface or our own wrappers. Thread-based conversation state MUST be managed via ThreadManager.

**Rationale**: The platform supports multiple LLM providers (Anthropic, OpenAI, Gemini, OpenRouter). Direct provider coupling creates vendor lock-in, makes A/B testing impossible, and complicates cost optimization. A unified interface enables provider switching, fallbacks, load balancing, and centralized usage tracking without rewriting agent logic.

### V. Idempotent Configuration & Reproducible Setup

The setup wizard (setup.py) MUST be idempotent and resumable. Environment configuration MUST be stored in .env files with clear documentation. Docker Compose configurations MUST produce identical environments across development machines. Database migrations MUST be versioned and applied sequentially. Service dependencies MUST be clearly documented and validated during setup.

**Rationale**: Kortix has 14+ required services (Supabase, Redis, Daytona, LLM providers, Tavily, Firecrawl, etc.). Manual setup is error-prone and creates "works on my machine" issues. Idempotent setup allows partial completion, recovery from failures, and onboarding of new contributors without hours of debugging.

## Security & Compliance

**Authentication & Authorization**: All API endpoints MUST validate Supabase JWT tokens or service role keys. Anonymous access is prohibited except for public endpoints explicitly marked as such. Agent execution MUST verify user ownership before accessing agent configurations or sandboxes.

**Secrets Management**: API keys and credentials MUST be stored in environment variables, never committed to version control. MCP credentials MUST be encrypted using MCP_CREDENTIAL_ENCRYPTION_KEY. Webhook signatures MUST be verified using TRIGGER_WEBHOOK_SECRET.

**Rate Limiting & Resource Controls**: Agent execution MUST enforce timeouts to prevent runaway processes. LLM API calls MUST track usage and enforce billing limits. Docker sandboxes MUST have resource limits (CPU, memory, disk) to prevent resource exhaustion attacks.

**Audit Logging**: Security events (login failures, permission denials, sandbox escapes) MUST be logged. Agent actions MUST be traceable to specific users and threads. Database mutations MUST include timestamps and user attribution.

## Development Workflow

**Branch Strategy**: Feature branches named feature/*, bug fixes on bugfix/*. Main branch protected, requires PR approval. Production deployments from tagged releases.

**Testing Requirements**: All PRs MUST pass ./test --unit and ./test --integration. LLM tests (./test --llm) recommended but not blocking due to cost. Coverage target is 60% minimum. Contract tests MUST pass for API changes.

**Code Review Standards**: PRs MUST be reviewed by at least one maintainer. Security changes (auth, sandboxing, multi-tenancy) require two approvals. Breaking changes MUST include migration guides and deprecation notices.

**Documentation Updates**: API changes MUST update docs/api.md. Configuration changes MUST update CLAUDE.md and setup.py documentation. Architecture changes MUST update README.md diagrams and descriptions.

**Commit Message Format**: Use conventional commits (feat:, fix:, docs:, test:, refactor:, chore:). Include issue numbers where applicable. Example: "feat(sandbox): add resource limit controls for Docker containers (#123)"

## Governance

**Constitutional Authority**: This constitution supersedes ad-hoc practices. When conflicts arise between this document and legacy patterns, this document takes precedence unless explicitly amended.

**Amendment Process**: Constitutional changes require:
1. Proposal via GitHub issue with rationale and impact analysis
2. Discussion period (minimum 7 days)
3. Approval from project maintainers
4. Version bump (MAJOR for backward-incompatible changes, MINOR for additions, PATCH for clarifications)
5. Migration plan for affected code
6. Update to dependent templates (plan-template.md, spec-template.md, tasks-template.md)

**Compliance Verification**: All PRs MUST verify alignment with constitutional principles during code review. Complexity or architectural deviations MUST be documented in plan.md Complexity Tracking sections with justification. The /plan command MUST execute Constitution Check gates before Phase 0 and after Phase 1.

**Runtime Guidance**: For day-to-day development guidance not codified in this constitution, refer to CLAUDE.md (project instructions) and ~/.claude/CLAUDE.md (user-specific standards). When Agent OS workflows are used, follow instructions in ~/.agent-os/instructions/.

**Versioning Policy**:
- **MAJOR** (X.0.0): Removal or redefinition of core principles that break backward compatibility
- **MINOR** (x.Y.0): Addition of new principles or significant expansion of existing sections
- **PATCH** (x.y.Z): Clarifications, wording improvements, non-semantic refinements

**Version**: 1.0.0 | **Ratified**: 2025-10-02 | **Last Amended**: 2025-10-02
