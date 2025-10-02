# Tasks: Platform Rebranding to Adentic

**Input**: Design documents from `/specs/001-our-goal-is/`
**Prerequisites**: plan.md (required), research.md, data-model.md, contracts/

## Execution Flow (main)
```
1. Load plan.md from feature directory
   → If not found: ERROR "No implementation plan found"
   → Extract: Python 3.11+, TypeScript/Next.js 15, FastAPI, Tailwind CSS
2. Load optional design documents:
   → data-model.md: BrandConfig, BrandAssets, EmailBrandConfig, SEOMetadata
   → contracts/brand-config.yaml: Brand configuration API
   → research.md: Asset strategy, color system, configuration
3. Generate tasks by category:
   → Setup: asset preparation, configuration files
   → Tests: contract tests, integration tests
   → Core: entity models, brand services
   → Integration: email templates, SEO metadata
   → Polish: unit tests, performance, docs
4. Apply task rules:
   → Different files = mark [P] for parallel
   → Same file = sequential (no [P])
   → Tests before implementation (TDD)
5. Number tasks sequentially (T001, T002...)
6. Generate dependency graph
7. Create parallel execution examples
8. Validate task completeness:
   → All contracts have tests? ✓
   → All entities have models? ✓
   → All endpoints implemented? N/A (config only)
9. Return: SUCCESS (tasks ready for execution)
```

## Format: `[ID] [P?] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- Include exact file paths in descriptions

## Path Conventions
- **Web app**: `backend/core/`, `frontend/src/`
- **Tests**: `backend/tests/`, `frontend/tests/`
- **Assets**: `frontend/public/`, `branding/`
- Paths shown below based on plan.md structure

## Phase 3.1: Setup
- [x] T001 Create project asset directories: frontend/public/brand/, backend/core/config/
- [x] T002 Process branding/*.jpeg into web-optimized logo.png (max 200KB)
- [x] T003 [P] Install image processing dependencies (sharp for Next.js, Pillow for Python)

## Phase 3.2: Tests First (TDD) ⚠️ MUST COMPLETE BEFORE 3.3
**CRITICAL: These tests MUST be written and MUST FAIL before ANY implementation**
- [x] T004 [P] Contract test for brand-config API in frontend/tests/contract/test_brand_config.ts
- [x] T005 [P] Integration test BrandConfig loading in frontend/tests/integration/test_brand_config.ts
- [x] T006 [P] Integration test EmailBrandConfig in backend/tests/integration/test_email_brand.py
- [x] T007 [P] Integration test SEOMetadata rendering in frontend/tests/integration/test_seo.ts
- [x] T008 [P] Integration test visual branding in frontend/tests/integration/test_visual_brand.ts

## Phase 3.3: Core Implementation (ONLY after tests are failing)
- [x] T009 [P] BrandConfig model in frontend/src/lib/brand-config.ts
- [x] T010 [P] BrandAssets model in frontend/src/lib/brand-assets.ts
- [x] T011 [P] EmailBrandConfig model in backend/core/config/brand.py
- [x] T012 [P] SEOMetadata service in frontend/src/lib/seo-metadata.ts
- [x] T013 Generate favicon.ico (16x16, 32x32) from logo
- [x] T014 Generate og-image.png (1200x630) with Adentic branding
- [x] T015 Generate apple-touch-icon.png (180x180) from logo
- [x] T016 Place all generated assets in frontend/public/

## Phase 3.4: Integration
- [x] T017 Update frontend/tailwind.config.js with brand-primary: '#CC3A00'
- [x] T018 Update frontend/src/app/layout.tsx with Adentic metadata
- [x] T019 Update frontend/src/components/layout/Header.tsx with logo and brand name
- [x] T020 Update frontend/src/components/layout/Footer.tsx with copyright and LinkedIn
- [x] T021 Update frontend/src/styles/globals.css with CSS variable --brand-primary
- [x] T022 Replace "Kortix" with "Adentic" in all frontend/src/**/*.tsx files
- [x] T023 Update backend email templates in backend/core/services/email/templates/
- [x] T024 Replace "Kortix" with "Adentic" in all backend/**/*.py files

## Phase 3.5: Polish
- [x] T025 [P] Unit tests for brand config validation in frontend/tests/unit/test_brand_validation.ts
- [x] T026 [P] Unit tests for email config in backend/tests/unit/test_brand_config.py
- [x] T027 [P] Update README.md with Adentic branding
- [x] T028 [P] Update CLAUDE.md project overview to use Adentic
- [x] T029 Optimize all image assets (compress, proper formats)
- [x] T030 Run quickstart.md verification checklist

## Dependencies
- Setup (T001-T003) before everything
- Tests (T004-T008) before implementation (T009-T024)
- T009-T012 (models) can run in parallel
- T013-T015 depend on T002 (processed logo)
- T016 depends on T013-T015 (generated assets)
- T017-T024 depend on T009-T012 (models exist)
- Polish (T025-T030) after all implementation

## Parallel Execution Examples
```
# Launch T004-T008 together (all test files):
Task: "Contract test for brand-config API in frontend/tests/contract/test_brand_config.ts"
Task: "Integration test BrandConfig loading in frontend/tests/integration/test_brand_config.ts"
Task: "Integration test EmailBrandConfig in backend/tests/integration/test_email_brand.py"
Task: "Integration test SEOMetadata rendering in frontend/tests/integration/test_seo.ts"
Task: "Integration test visual branding in frontend/tests/integration/test_visual_brand.ts"
```

```
# Launch T009-T012 together (different model files):
Task: "BrandConfig model in frontend/src/lib/brand-config.ts"
Task: "BrandAssets model in frontend/src/lib/brand-assets.ts"
Task: "EmailBrandConfig model in backend/core/config/brand.py"
Task: "SEOMetadata service in frontend/src/lib/seo-metadata.ts"
```

```
# Launch T025-T028 together (different doc/test files):
Task: "Unit tests for brand config validation in frontend/tests/unit/test_brand_validation.ts"
Task: "Unit tests for email config in backend/tests/unit/test_brand_config.py"
Task: "Update README.md with Adentic branding"
Task: "Update CLAUDE.md project overview to use Adentic"
```

## Notes
- [P] tasks = different files, no dependencies
- Verify tests fail before implementing
- Commit after each task group
- Avoid: vague tasks, same file conflicts

## Task Generation Rules
*Applied during main() execution*

1. **From Contracts**:
   - brand-config.yaml → T004 contract test [P]

2. **From Data Model**:
   - BrandConfig entity → T009 model creation [P]
   - BrandAssets entity → T010 model creation [P]
   - EmailBrandConfig entity → T011 model creation [P]
   - SEOMetadata entity → T012 service creation [P]

3. **From User Stories**:
   - Homepage branding → T008 integration test [P]
   - Email templates → T006 integration test [P]
   - SEO metadata → T007 integration test [P]

4. **Ordering**:
   - Setup → Tests → Models → Services → Integration → Polish
   - Dependencies block parallel execution

## Validation Checklist
*GATE: Checked by main() before returning*

- [x] All contracts have corresponding tests (T004)
- [x] All entities have model tasks (T009-T012)
- [x] All tests come before implementation (T004-T008 before T009-T024)
- [x] Parallel tasks truly independent (different files)
- [x] Each task specifies exact file path
- [x] No task modifies same file as another [P] task