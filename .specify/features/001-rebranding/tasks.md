# Tasks: Automated Rebranding System - Adentic Implementation

**Input**: Design documents from `.specify/features/001-rebranding/`
**Prerequisites**: plan.md (required), research.md, data-model.md, contracts/

## Execution Flow (main)
```
1. Load plan.md from feature directory
   → Tech stack: Python 3.11, pathlib, json, shutil, argparse, re
   → Structure: Single project (CLI tool)
2. Load optional design documents:
   → data-model.md: BrandConfiguration, ChangeReport, BackupManifest entities
   → contracts/cli-interface.yaml: CLI parameter validation
   → research.md: Technical decisions extracted
3. Generate tasks by category:
   → Setup: Python project init, test structure
   → Tests: Contract tests, entity validation tests
   → Core: Rebrander class, backup logic, report generation
   → Integration: Full rebranding flow tests
   → Polish: Performance optimization, documentation
4. Apply task rules:
   → Different files = mark [P] for parallel
   → Same file = sequential (no [P])
   → Tests before implementation (TDD)
5. Number tasks sequentially (T001-T025)
6. Generate dependency graph
7. Create parallel execution examples
8. Return: SUCCESS (tasks ready for execution)
```

## Format: `[ID] [P?] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- Include exact file paths in descriptions

## Path Conventions
- **Single project**: Repository root for CLI tool
- Tests in `tests/` directory
- Main script at root level

## Phase 3.1: Setup
- [ ] T001 Create test directory structure with tests/, tests/fixtures/, tests/unit/, tests/integration/
- [ ] T002 [P] Create Adentic brand assets directory with logo files and brand images
- [ ] T003 [P] Create adentic_config.json with TryAdentic brand configuration

## Phase 3.2: Tests First (TDD) ⚠️ MUST COMPLETE BEFORE 3.3
**CRITICAL: These tests MUST be written and MUST FAIL before ANY implementation**
- [ ] T004 [P] Test BrandConfiguration validation in tests/unit/test_brand_config.py
- [ ] T005 [P] Test text replacement logic in tests/unit/test_text_replacement.py
- [ ] T006 [P] Test image replacement logic in tests/unit/test_image_replacement.py
- [ ] T007 [P] Test backup functionality in tests/unit/test_backup.py
- [ ] T008 [P] Test report generation in tests/unit/test_report.py
- [ ] T009 [P] Integration test dry-run mode in tests/integration/test_dry_run.py
- [ ] T010 [P] Integration test full rebranding flow in tests/integration/test_full_rebrand.py

## Phase 3.3: Core Implementation (ONLY after tests are failing)
- [ ] T011 Implement BrandConfiguration class with Adentic defaults in rebrand.py (lines 1-100)
- [ ] T012 Implement Rebrander class with main logic in rebrand.py (lines 101-250)
- [ ] T013 Implement text replacement with Adentic→Adentic mapping in rebrand.py (lines 251-350)
- [ ] T014 Implement image replacement logic in rebrand.py (lines 351-450)
- [ ] T015 Implement file renaming logic in rebrand.py (lines 451-550)
- [ ] T016 Implement backup creation and manifest in rebrand.py (lines 551-650)
- [ ] T017 Implement report generation with ChangeReport in rebrand.py (lines 651-750)
- [ ] T018 Implement CLI argument parsing with argparse in rebrand.py (lines 751-850)
- [ ] T019 Implement main execution flow in rebrand.py (lines 851-950)

## Phase 3.4: Integration
- [ ] T020 Apply Adentic branding to frontend/src/lib/site.ts
- [ ] T021 Apply Adentic branding to backend configuration files
- [ ] T022 Update environment variables from ADENTIC_ to ADENTIC_
- [ ] T023 Replace all Adentic/Adentic image assets with Adentic assets

## Phase 3.5: Polish
- [ ] T024 [P] Add performance timing and progress indicators
- [ ] T025 [P] Create README_ADENTIC.md with Adentic-specific instructions

## Adentic Brand Configuration
```json
{
  "brand_name": "Adentic",
  "product_name": "Adentic",
  "company_name": "TryAdentic",
  "full_product_name": "TryAdentic",
  "website_url": "https://tryadentic.com",
  "twitter_url": "https://x.com/tryadentic",
  "github_url": "https://github.com/tryadentic/",
  "linkedin_url": "https://www.linkedin.com/company/tryadentic",
  "primary_color": "#CC3A00",
  "tagline": "AI-powered automation for marketing agencies",
  "description": "Automated client reports that save over 1000 hours per month",
  "new_assets_dir": "./adentic_brand_assets"
}
```

## Dependencies
- Tests (T004-T010) must complete before implementation (T011-T019)
- T011 blocks T012-T019 (sequential file editing)
- T020-T023 require T011-T019 complete
- T024-T025 can run after T019

## Parallel Example
```bash
# Launch T004-T010 together (different test files):
Task: "Test BrandConfiguration validation in tests/unit/test_brand_config.py"
Task: "Test text replacement logic in tests/unit/test_text_replacement.py"
Task: "Test image replacement logic in tests/unit/test_image_replacement.py"
Task: "Test backup functionality in tests/unit/test_backup.py"
Task: "Test report generation in tests/unit/test_report.py"
Task: "Integration test dry-run mode in tests/integration/test_dry_run.py"
Task: "Integration test full rebranding flow in tests/integration/test_full_rebrand.py"
```

## Notes
- [P] tasks = different files, no dependencies
- Verify tests fail before implementing
- Use Adentic brand values throughout (#CC3A00 color, TryAdentic name)
- Focus on marketing agency use case in documentation
- Emphasize automation and time-saving benefits

## Task Generation Rules
*Applied during main() execution*

1. **From Contracts**:
   - CLI interface contract → argument parsing tests and implementation

2. **From Data Model**:
   - BrandConfiguration → validation and initialization
   - ChangeReport → tracking and output formatting
   - BackupManifest → backup/restore functionality

3. **From User Stories**:
   - Dry-run preview → test and implementation
   - Full rebranding → integration test
   - Backup/restore → safety features

4. **Ordering**:
   - Setup → Tests → Core classes → Features → Integration → Polish

## Validation Checklist
*GATE: Checked by main() before returning*

- [x] All entities have implementation tasks
- [x] All tests come before implementation
- [x] Parallel tasks truly independent
- [x] Each task specifies exact file path
- [x] No task modifies same file as another [P] task
- [x] Adentic branding specifics included
- [x] Color code #CC3A00 documented
- [x] LinkedIn URL included as specified