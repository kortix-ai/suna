
# Implementation Plan: Platform Rebranding to Adentic

**Branch**: `001-our-goal-is` | **Date**: 2025-10-02 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-our-goal-is/spec.md`

## Execution Flow (/plan command scope)
```
1. Load feature spec from Input path
   → If not found: ERROR "No feature spec at {path}"
2. Fill Technical Context (scan for NEEDS CLARIFICATION)
   → Detect Project Type from file system structure or context (web=frontend+backend, mobile=app+api)
   → Set Structure Decision based on project type
3. Fill the Constitution Check section based on the content of the constitution document.
4. Evaluate Constitution Check section below
   → If violations exist: Document in Complexity Tracking
   → If no justification possible: ERROR "Simplify approach first"
   → Update Progress Tracking: Initial Constitution Check
5. Execute Phase 0 → research.md
   → If NEEDS CLARIFICATION remain: ERROR "Resolve unknowns"
6. Execute Phase 1 → contracts, data-model.md, quickstart.md, agent-specific template file (e.g., `CLAUDE.md` for Claude Code, `.github/copilot-instructions.md` for GitHub Copilot, `GEMINI.md` for Gemini CLI, `QWEN.md` for Qwen Code or `AGENTS.md` for opencode).
7. Re-evaluate Constitution Check section
   → If new violations: Refactor design, return to Phase 1
   → Update Progress Tracking: Post-Design Constitution Check
8. Plan Phase 2 → Describe task generation approach (DO NOT create tasks.md)
9. STOP - Ready for /tasks command
```

**IMPORTANT**: The /plan command STOPS at step 7. Phases 2-4 are executed by other commands:
- Phase 2: /tasks command creates tasks.md
- Phase 3-4: Implementation execution (manual or via tools)

## Summary
Rebrand the Kortix platform to "Adentic" across all user-facing touchpoints including web interface, transactional emails, social media links, and brand assets. This involves updating logos, colors (#CC3A00), copyright text, SEO metadata, and ensuring consistent brand presentation throughout the platform.

## Technical Context
**Language/Version**: Python 3.11+ (backend), TypeScript/Next.js 15 (frontend)
**Primary Dependencies**: FastAPI, Next.js, Supabase, Redis, Tailwind CSS, Radix UI
**Storage**: Supabase (PostgreSQL), Redis (cache), file system (brand assets)
**Testing**: pytest (backend), Jest/React Testing Library (frontend)
**Target Platform**: Web application (Docker containerized)
**Project Type**: web - frontend + backend architecture
**Performance Goals**: N/A - branding update, no performance impact expected
**Constraints**: Manual cache clearing acceptable (no active customers)
**Scale/Scope**: Full platform rebrand affecting ~20+ frontend pages, email templates, configuration files

## Constitution Check
*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**I. Agent Safety & Isolation**
- [x] Does this feature execute agent code? If yes: MUST use Daytona Docker sandboxes → **N/A - No agent code execution**
- [x] Are container resource limits (CPU, memory, disk) specified? → **N/A - UI/config change only**
- [x] Is the container snapshot versioned and reproducible? → **N/A - Using existing containers**

**II. Test-Driven Development (TDD)**
- [ ] Are contract tests planned for all new API endpoints? → **N/A - No new API endpoints**
- [x] Are integration tests planned for agent workflows and cross-service interactions? → **N/A - No agent workflow changes**
- [x] Are unit tests planned for business logic and validation? → **Yes - Brand config validation tests**
- [x] Is the test-first order enforced in task planning (tests before implementation)? → **Yes - Tests first in tasks**

**III. Multi-Tenancy & Data Isolation**
- [x] Does this feature access user data, agent configs, or conversation threads? → **No - Brand config is system-wide**
- [x] Are Supabase RLS policies defined/updated to enforce tenant boundaries? → **N/A - No data model changes**
- [x] Is cross-account access prevented (or explicitly authorized if required)? → **N/A - System-wide branding**

**IV. LLM Provider Abstraction**
- [x] Do LLM calls use core.services.llm.make_llm_api_call() via LiteLLM? → **N/A - No LLM calls**
- [x] Is conversation state managed through ThreadManager? → **N/A - No conversation changes**
- [x] Are provider-specific features abstracted (no direct Anthropic/OpenAI SDK calls)? → **N/A - No LLM integration**

**V. Idempotent Configuration & Reproducible Setup**
- [x] Are new environment variables documented in CLAUDE.md and setup.py? → **Yes - Will update brand config vars**
- [x] Is Docker Compose configuration updated if services change? → **No service changes needed**
- [x] Are database migrations versioned and sequential? → **N/A - No schema changes**
- [x] Are service dependencies validated during setup? → **N/A - No new dependencies**

**Security & Compliance**
- [x] Are all new API endpoints protected by Supabase JWT or service role validation? → **N/A - No new endpoints**
- [x] Are secrets stored in environment variables (not hardcoded)? → **N/A - No secrets, just brand config**
- [x] Are rate limits and timeouts enforced for resource-intensive operations? → **N/A - Static asset serving**
- [x] Are security events logged with user attribution? → **N/A - No security-sensitive changes**

**Development Workflow**
- [x] Will this feature follow conventional commit format (feat:, fix:, etc.)? → **Yes - feat: rebrand to Adentic**
- [x] Are documentation updates planned (API docs, CLAUDE.md, README if needed)? → **Yes - Update CLAUDE.md with new brand**
- [x] Is code review process defined (1+ maintainer, 2 for security changes)? → **Yes - Standard 1 maintainer review**

## Project Structure

### Documentation (this feature)
```
specs/[###-feature]/
├── plan.md              # This file (/plan command output)
├── research.md          # Phase 0 output (/plan command)
├── data-model.md        # Phase 1 output (/plan command)
├── quickstart.md        # Phase 1 output (/plan command)
├── contracts/           # Phase 1 output (/plan command)
└── tasks.md             # Phase 2 output (/tasks command - NOT created by /plan)
```

### Source Code (repository root)
```
backend/
├── core/
│   ├── config/           # Brand configuration constants
│   ├── services/         # Email service with templates
│   └── static/           # Backend static assets
├── tests/
│   └── unit/            # Brand config validation tests
└── supabase/
    └── migrations/      # If brand data needs DB storage

frontend/
├── src/
│   ├── components/      # UI components with brand colors
│   ├── app/            # Next.js app pages with SEO metadata
│   ├── styles/         # Global styles with brand colors
│   └── lib/            # Configuration constants
├── public/             # Static assets (logos, favicons)
└── tests/              # Frontend brand display tests

branding/               # Source brand assets
├── *.jpeg             # Logo variations
└── *.pdf              # Brand guidelines document
```

**Structure Decision**: Web application structure (frontend + backend) is used since this is a full-stack platform rebrand affecting both the Next.js frontend UI and FastAPI backend email templates.

## Phase 0: Outline & Research
1. **Extract unknowns from Technical Context** above:
   - For each NEEDS CLARIFICATION → research task
   - For each dependency → best practices task
   - For each integration → patterns task

2. **Generate and dispatch research agents**:
   ```
   For each unknown in Technical Context:
     Task: "Research {unknown} for {feature context}"
   For each technology choice:
     Task: "Find best practices for {tech} in {domain}"
   ```

3. **Consolidate findings** in `research.md` using format:
   - Decision: [what was chosen]
   - Rationale: [why chosen]
   - Alternatives considered: [what else evaluated]

**Output**: research.md with all NEEDS CLARIFICATION resolved

## Phase 1: Design & Contracts
*Prerequisites: research.md complete*

1. **Extract entities from feature spec** → `data-model.md`:
   - Entity name, fields, relationships
   - Validation rules from requirements
   - State transitions if applicable

2. **Generate API contracts** from functional requirements:
   - For each user action → endpoint
   - Use standard REST/GraphQL patterns
   - Output OpenAPI/GraphQL schema to `/contracts/`

3. **Generate contract tests** from contracts:
   - One test file per endpoint
   - Assert request/response schemas
   - Tests must fail (no implementation yet)

4. **Extract test scenarios** from user stories:
   - Each story → integration test scenario
   - Quickstart test = story validation steps

5. **Update agent file incrementally** (O(1) operation):
   - Run `.specify/scripts/bash/update-agent-context.sh copilot`
     **IMPORTANT**: Execute it exactly as specified above. Do not add or remove any arguments.
   - If exists: Add only NEW tech from current plan
   - Preserve manual additions between markers
   - Update recent changes (keep last 3)
   - Keep under 150 lines for token efficiency
   - Output to repository root

**Output**: data-model.md, /contracts/*, failing tests, quickstart.md, agent-specific file

## Phase 2: Task Planning Approach
*This section describes what the /tasks command will do - DO NOT execute during /plan*

**Task Generation Strategy**:
- Load `.specify/templates/tasks-template.md` as base
- Generate tasks from Phase 1 design docs (contracts, data model, quickstart)
- Brand configuration setup tasks
- Asset processing and placement tasks
- Frontend component updates (parallel by component)
- Backend email template updates
- Testing and verification tasks

**Ordering Strategy**:
- Asset preparation first (logos, favicons)
- Configuration constants before component updates
- Frontend and backend updates can run in parallel
- Testing tasks after implementation
- Mark [P] for parallel execution (independent files)

**Estimated Output**: 20-25 numbered, ordered tasks in tasks.md

**Task Categories Expected**:
1. Asset Processing (3-4 tasks)
2. Configuration Setup (2-3 tasks)
3. Frontend Updates (8-10 tasks)
4. Backend Updates (3-4 tasks)
5. Testing & Verification (4-5 tasks)

**IMPORTANT**: This phase is executed by the /tasks command, NOT by /plan

## Phase 3+: Future Implementation
*These phases are beyond the scope of the /plan command*

**Phase 3**: Task execution (/tasks command creates tasks.md)  
**Phase 4**: Implementation (execute tasks.md following constitutional principles)  
**Phase 5**: Validation (run tests, execute quickstart.md, performance validation)

## Complexity Tracking
*Fill ONLY if Constitution Check has violations that must be justified*

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |


## Progress Tracking
*This checklist is updated during execution flow*

**Phase Status**:
- [x] Phase 0: Research complete (/plan command)
- [x] Phase 1: Design complete (/plan command)
- [x] Phase 2: Task planning complete (/plan command - describe approach only)
- [ ] Phase 3: Tasks generated (/tasks command)
- [ ] Phase 4: Implementation complete
- [ ] Phase 5: Validation passed

**Gate Status**:
- [x] Initial Constitution Check: PASS
- [x] Post-Design Constitution Check: PASS
- [x] All NEEDS CLARIFICATION resolved
- [x] Complexity deviations documented (none needed)

---
*Based on Constitution v1.0.0 - See `.specify/memory/constitution.md`*
