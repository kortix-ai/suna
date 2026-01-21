# Kortix to SprintLab Rebranding Plan

> Comprehensive plan for rebranding all user-facing references from "Kortix" to "SprintLab" across the entire codebase.

**Created:** January 2026  
**New Domain:** `sprintlab.id`  
**New GitHub Org:** `sprintlab`  
**New Mobile App IDs:** `com.sprintlab.app`

---

## Table of Contents

1. [Phase 1: Core Configuration Files](#phase-1-core-configuration-files)
2. [Phase 1.5: Desktop App Configuration](#phase-15-desktop-app-configuration)
3. [Phase 2: Backend Configuration](#phase-2-backend-configuration)
4. [Phase 3: Email Templates](#phase-3-email-templates-12-files)
5. [Phase 4: Localization Files](#phase-4-localization-files-16-files)
6. [Phase 5: iOS Project Restructure](#phase-5-mobile-app---ios-project-restructure)
7. [Phase 6: Android Project Restructure](#phase-6-mobile-app---android-project-restructure)
8. [Phase 7: SDK Restructure](#phase-7-sdk-restructure)
9. [Phase 8: Frontend Components Rename](#phase-8-frontend-components-rename)
10. [Phase 9: Mobile Components Rename](#phase-9-mobile-components-rename)
11. [Phase 10: Static Assets](#phase-10-static-assets)
12. [Phase 11: Documentation Updates](#phase-11-documentation-updates)
13. [Phase 12: Database Migrations & Config](#phase-12-database-migrations--config)
14. [Phase 13: Remaining Text Replacements](#phase-13-remaining-text-replacements)

---

## Phase 1: Core Configuration Files

Update central configuration that affects the entire application:

| File | Changes |
|------|---------|
| `apps/frontend/src/lib/site-metadata.ts` | Change name, title, description, url, keywords |
| `apps/frontend/src/lib/site-config.ts` | Update hero description, footer links, contact email |
| `apps/frontend/public/manifest.json` | Update PWA name, description, app store URLs |
| `apps/frontend/public/robots.txt` | Update sitemap URL and comments |
| `apps/frontend/package.json` | Change package name |
| `apps/frontend/next.config.ts` | Update any domain references |
| `apps/mobile/app.json` | Update name, slug, scheme, bundleId, package, owner, permissions |
| `package.json` (root) | Update pnpm filter references |
| `docker-compose.yaml` | Update comments and service names |

---

## Phase 1.5: Desktop App Configuration

| File | Changes |
|------|---------|
| `apps/desktop/package.json` | Update name, description, author, appId, productName, protocol schemes |
| `apps/desktop/main.js` | Update PROTOCOL_SCHEME, APP_URL, app name |
| `apps/desktop/README.md` | Update documentation |

---

## Phase 2: Backend Configuration

| File | Changes |
|------|---------|
| `backend/core/prompts/core_prompt.py` | Change AI identity from "Kortix" to "SprintLab" |
| `backend/core/prompts/memory_extraction_prompt.py` | Update any brand references |
| `backend/api.py` | Update CORS origins from kortix.com to sprintlab.id |
| `backend/pyproject.toml` | Update package metadata |
| `backend/docker-compose.yml` | Update comments |
| `backend/core/utils/config.py` | Update any hardcoded references |
| `backend/core/utils/openapi_config.py` | Update API documentation title |
| `backend/core/config/suna_config.py` | Update configuration references |

### Additional Backend Files (Services)

| File | Changes |
|------|---------|
| `backend/core/notifications/notification_service.py` | Update notification content |
| `backend/core/notifications/api.py` | Update API references |
| `backend/core/agents/agent_service.py` | Update agent branding |
| `backend/core/memory/extraction_service.py` | Update extraction context |
| `backend/core/services/email.py` | Update email service references |
| `backend/core/services/worker_metrics.py` | Update metric labels |

### Backend Tools

| File | Changes |
|------|---------|
| `backend/core/tools/sb_kb_tool.py` | Update tool descriptions |
| `backend/core/tools/sb_files_tool.py` | Update tool descriptions |
| `backend/core/tools/sb_file_reader_tool.py` | Update tool descriptions |
| `backend/core/tools/agent_builder_tools/trigger_tool.py` | Update tool descriptions |
| `backend/core/tools/agent_builder_tools/agent_config_tool.py` | Update tool descriptions |

### Backend Sandbox

| File | Changes |
|------|---------|
| `backend/core/sandbox/docker/docker-compose.yml` | Update service names |
| `backend/core/sandbox/docker/browserApi.ts` | Update API references |
| `backend/core/sandbox/canvas_ai_api.py` | Update API references |
| `backend/core/sandbox/README.md` | Update documentation |

### Backend Templates

| File | Changes |
|------|---------|
| `backend/core/templates/utils.py` | Update template utilities |
| `backend/core/templates/template_service.py` | Update service references |
| `backend/core/templates/services/marketplace_service.py` | Update marketplace references |
| `backend/core/templates/presentations_api.py` | Update API references |
| `backend/core/templates/installation_service.py` | Update installation references |
| `backend/core/templates/api.py` | Update API references |

### Backend Admin

| File | Changes |
|------|---------|
| `backend/core/admin/analytics_admin_api.py` | Update admin references |
| `backend/core/admin/stress_test_admin_api.py` | Update admin references |

### Backend Billing

| File | Changes |
|------|---------|
| `backend/core/billing/external/revenuecat/utils/product_mapper.py` | Update product references |

### Backend Evals (9 files)

- `backend/evals/test_simple.py`, `test_quick.py`, `test_cases.json`, `runner.py`, `eval_simple.py`, `datasets.py`, `agent_eval.py`, `__init__.py`, `README.md`

### Backend Tests (5 files)

- `backend/tests/core/agentpress/test_context_manager_compression.py`, `conftest.py`, `config.py`, `__init__.py`, `README.md`

---

## Phase 3: Email Templates (12 files)

Update all email templates in `backend/supabase/emails/`:

- Auth emails: `confirm_sign_up.html`, `magic_link.html`, `reset_password.html`, `change_email.html`, `invite_user.html`, `reauthentication.html`
- Novu templates: `welcome-email.html`, `task-completion-template.html`, `subscription-update.html`, `promotion-test.html`, `default-layout.html`
- Base template: `email-template.html`

**Changes:** Replace "Kortix" branding, update logo URLs from kortix.com to sprintlab.id, update copyright text.

---

## Phase 4: Localization Files (16 files)

Update translation files in both frontend and mobile:

**Frontend** (`apps/frontend/translations/`): `en.json`, `de.json`, `es.json`, `fr.json`, `it.json`, `ja.json`, `pt.json`, `zh.json`

**Mobile** (`apps/mobile/locales/`): `en.json`, `de.json`, `es.json`, `fr.json`, `it.json`, `ja.json`, `pt.json`, `zh.json`

Each file contains ~12-18 "Kortix" references in UI strings.

---

## Phase 5: Mobile App - iOS Project Restructure

Rename iOS project structure from "Kortix" to "SprintLab":

| Current Path | New Path |
|--------------|----------|
| `apps/mobile/ios/Kortix/` | `apps/mobile/ios/SprintLab/` |
| `apps/mobile/ios/Kortix.xcodeproj/` | `apps/mobile/ios/SprintLab.xcodeproj/` |
| `apps/mobile/ios/Kortix.xcworkspace/` | `apps/mobile/ios/SprintLab.xcworkspace/` |

Update internal references in:

- `project.pbxproj` (~53 references)
- `Kortix.xcscheme` (~12 references)
- `Info.plist`, `kortix.entitlements` → `sprintlab.entitlements`
- `Podfile`

---

## Phase 6: Mobile App - Android Project Restructure

| Current Path | New Path |
|--------------|----------|
| `apps/mobile/android/app/src/main/java/com/kortix/` | `apps/mobile/android/app/src/main/java/com/sprintlab/` |

Update:

- `AndroidManifest.xml` - package name and intent filters
- `build.gradle` - applicationId
- `settings.gradle` - project name
- `MainActivity.kt`, `MainApplication.kt` - package declarations
- `strings.xml` - app name

---

## Phase 7: SDK Restructure

Rename SDK package from `kortix` to `sprintlab`:

| Current | New |
|---------|-----|
| `sdk/kortix/` | `sdk/sprintlab/` |
| `sdk/kortix/kortix.py` | `sdk/sprintlab/sprintlab.py` |

Update:

- `sdk/pyproject.toml` - package name
- `sdk/README.md` - documentation
- `sdk/__init__.py` - imports
- All example files referencing the SDK

---

## Phase 8: Frontend Components Rename

Rename component files and directories:

| Current | New |
|---------|-----|
| `apps/frontend/src/components/thread/kortix-computer/` | `apps/frontend/src/components/thread/sprintlab-computer/` |
| `apps/frontend/src/stores/kortix-computer-store.ts` | `apps/frontend/src/stores/sprintlab-computer-store.ts` |
| `apps/frontend/src/components/ui/kortix-loader.tsx` | `apps/frontend/src/components/ui/sprintlab-loader.tsx` |
| `apps/frontend/src/components/announcements/kortix-app-banners.tsx` | `apps/frontend/src/components/announcements/sprintlab-app-banners.tsx` |
| `apps/frontend/src/components/thread/tool-views/spreadsheet/kortix-spreadsheet-styles.css` | `apps/frontend/src/components/thread/tool-views/spreadsheet/sprintlab-spreadsheet-styles.css` |

### Additional Frontend Files to Update (~100+ files)

**Hooks (9 files):**

- `apps/frontend/src/hooks/messages/utils/assistant-message-renderer.tsx`
- `apps/frontend/src/hooks/dashboard/use-agent-start-input.ts`
- `apps/frontend/src/hooks/utils/use-promo.ts`
- `apps/frontend/src/hooks/threads/use-mode-viewer-init.ts`
- `apps/frontend/src/hooks/threads/page/use-thread-keyboard-shortcuts.ts`
- `apps/frontend/src/hooks/secure-mcp/use-secure-mcp.ts`
- `apps/frontend/src/hooks/messages/useThreadToolCalls.ts`
- `apps/frontend/src/hooks/agents/utils.ts`
- `apps/frontend/src/hooks/agents/use-model-selection.ts`

**Lib Files (7 files):**

- `apps/frontend/src/lib/utils/is-mobile-device.ts`
- `apps/frontend/src/lib/utils/is-electron.ts`
- `apps/frontend/src/lib/pricing-config.ts`
- `apps/frontend/src/lib/model-provider-icons.tsx`
- `apps/frontend/src/lib/analytics/gtm.ts`

**App Pages (47 files):**

- All pages in `apps/frontend/src/app/` containing Kortix references
- Key pages: `auth/`, `(home)/careers/`, `(home)/about/`, `legal/`, `suna/`, `subscription/`, `share/`, `checkout/`, `help/`, `agents-101/`, `(dashboard)/`

**Components:**

- `apps/frontend/src/components/help/help-sidebar.tsx`
- `apps/frontend/src/components/common/app-download-qr.tsx`
- Multiple tool-view components (~30 files)
- Multiple UI components (~20 files)

**CSS Files:**

- `apps/frontend/src/app/globals.css`

Update all imports referencing renamed files.

---

## Phase 9: Mobile Components Rename

| Current | New |
|---------|-----|
| `apps/mobile/components/kortix-computer/` | `apps/mobile/components/sprintlab-computer/` |
| `apps/mobile/stores/kortix-computer-store.ts` | `apps/mobile/stores/sprintlab-computer-store.ts` |
| `apps/mobile/components/ui/kortix-loader.tsx` | `apps/mobile/components/ui/sprintlab-loader.tsx` |
| `apps/mobile/components/ui/KortixLogo.tsx` | `apps/mobile/components/ui/SprintLabLogo.tsx` |

---

## Phase 10: Static Assets

Rename logo/brand assets in `apps/frontend/public/`:

| Current | New |
|---------|-----|
| `kortix-brandmark-effect.svg` | `sprintlab-brandmark-effect.svg` |
| `kortix-brandmark-effect-full.svg` | `sprintlab-brandmark-effect-full.svg` |
| `kortix-computer-black.svg` | `sprintlab-computer-black.svg` |
| `kortix-computer-white.svg` | `sprintlab-computer-white.svg` |
| `kortix-logomark-white.svg` | `sprintlab-logomark-white.svg` |
| `kortix-symbol.svg` | `sprintlab-symbol.svg` |

**Note:** You will need to provide new SVG logo files with SprintLab branding, or rename the files and replace the content later.

---

## Phase 11: Documentation Updates

Update all documentation files:

| File | Changes |
|------|---------|
| `README.md` | Update project name, description, URLs |
| `ARCHITECTURE.md` | Update architecture references |
| `CLAUDE.md` | Update project context for AI assistants |
| `LICENSE` | Update copyright holder from "Kortix AI Corp" to "SprintLab" |
| `setup.py` | Update package setup references |
| `docs/README.md` | Update documentation index |
| `docs/BACKEND.md` | Update CORS and domain references |
| `docs/FRONTEND.md` | Update component references |
| `docs/API_REFERENCE.md` | Update API documentation |
| `docs/DEVELOPMENT.md` | Update development references |
| `docs/TOOL_IMPLEMENTATION_GUIDE.md` | Update tool guide references |
| `apps/mobile/README.md` | Update mobile app documentation |
| `apps/mobile/BUILD_GUIDE.md` | Update build guide |
| `apps/desktop/README.md` | Update desktop app documentation |
| `sdk/README.md` | Update SDK documentation |
| `backend/README.md` | Update backend documentation |
| `backend/tests/README.md` | Update test documentation |
| `backend/evals/README.md` | Update eval documentation |
| `backend/core/test_harness/README.md` | Update test harness documentation |
| `backend/core/sandbox/README.md` | Update sandbox documentation |

---

## Phase 12: Database Migrations & Config

| File | Changes |
|------|---------|
| `backend/supabase/config.toml` | Update site_url |
| SQL migrations with "kortix_team" references | Update team identifiers |

---

## Phase 13: Remaining Text Replacements

Global search-and-replace across ~380 files for remaining occurrences:

- UI text strings
- Comments and documentation
- URL references (kortix.com → sprintlab.id)
- GitHub URLs (kortix-ai → sprintlab)

---

## Summary Statistics

| Category | File Count |
|----------|------------|
| Core configuration files | ~12 |
| Desktop app files | 4 |
| Backend configuration | ~8 |
| Backend services/tools/sandbox | ~35 |
| Backend evals/tests | ~14 |
| Email templates | 12 |
| Localization files | 16 |
| iOS project files | ~8 |
| Android project files | ~6 |
| SDK files | ~10 |
| Frontend hooks/lib | ~16 |
| Frontend app pages | ~47 |
| Frontend components | ~80 |
| Mobile components | ~40 |
| Static assets | ~6 |
| CSS files | 3 |
| Documentation | ~20 |
| Database/migrations | ~5 |
| **Total files affected** | **~464** |

---

## Key Replacements Summary

| Find | Replace |
|------|---------|
| `Kortix` | `SprintLab` |
| `kortix` | `sprintlab` |
| `KORTIX` | `SPRINTLAB` |
| `kortix.com` | `sprintlab.id` |
| `kortix-ai` (GitHub) | `sprintlab` |
| `com.kortix.app` | `com.sprintlab.app` |
| `hey@kortix.com` | `hey@sprintlab.id` |
| `support@kortix.com` | `support@sprintlab.id` |

---

## Execution Order

Execute in the order listed (Phase 1 through 13) as later phases depend on earlier ones. The most critical user-facing changes are in Phases 1-4.

**Priority Order:**

1. **Immediate user impact:** Phases 1, 2, 3, 4 (configs, prompts, emails, locales)
2. **Mobile app stores:** Phases 5, 6 (iOS, Android restructuring)
3. **Developer experience:** Phases 7, 8, 9 (SDK, component renames)
4. **Assets:** Phase 10 (requires new logo files)
5. **Housekeeping:** Phases 11, 12, 13 (docs, database, cleanup)

---

## Important Notes

1. **Logo Assets:** You will need to provide new SprintLab logo SVG/PNG files to replace the kortix-*.svg files
2. **App Store Submissions:** Changing bundle IDs (com.kortix.app to com.sprintlab.app) will require new app submissions
3. **DNS/Domains:** Ensure sprintlab.id domain is configured before deployment
4. **Database:** The `kortix_team` references in migrations may be historical and could be left as-is if they don't affect users

---

*This plan was generated on January 2026. For updates, search the codebase for remaining "kortix" references.*
