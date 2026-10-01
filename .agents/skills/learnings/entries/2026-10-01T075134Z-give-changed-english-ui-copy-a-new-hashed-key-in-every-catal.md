---
recorded: 2026-10-01T07:51:34Z
incident_date: 2026-10-01
---
# Give changed English UI copy a new hashed key in every catalog; editing the value under the old key leaves every other locale on English

**Rule:** When you change English copy that `apps/web` reads through a generated translation map (`src/i18n/*-translation-keys.generated.ts`), add the new English as a new map entry with key `text` + `sha256(English)[:12]`, and add that key to `hardcodedUi.i18nComplete` in all nine `translations/*.json`. Never edit the value under the old key. Run `node apps/web/scripts/audit-i18n.mjs --max-hardcoded=0` before merging.

**Trigger surface:** Rewriting product or marketing copy in `src/lib/blog-posts.ts`, `src/lib/seo/public-content.ts`, `src/lib/site-config.ts`, `src/features/marketing/**`, or any `localizeUiCatalog` source; adding new JSX text to a page.

**Incident:** 2026-10-01, 7e5e3735d4 (#8567, brand kit) rewrote 13 English strings in source and put some new translations under the old keys. The runtime looks a string up by its English text, so the new text found no key: blog titles and descriptions, SEO descriptions, the site description, the open-source headline and two IT-role strings showed English on all eight non-English locales. 11 new `/design-system` strings had no key at all. The strict audit found 24 findings, but the `packages` lane stopped before `apps/web` (see the 2026-10-01 entry on lane fail-fast), so `main` hid it for about 3.5 hours. Fixed in #8587 with 21 new keys in all nine catalogs.

**Enforcement:** `apps/web/scripts/audit-i18n.test.mjs` (strict audit, `--max-hardcoded=0`) in the `packages` lane. It reaches `apps/web` only when every earlier package passes.
