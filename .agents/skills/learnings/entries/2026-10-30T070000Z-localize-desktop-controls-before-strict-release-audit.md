---
recorded: 2026-10-30T07:00:00Z
incident_date: 2026-10-30
---
# Localize desktop controls before the strict release audit

**Rule:** New session controls must use the UI translation hook, populate all supported locale catalogs, and regenerate the bundled UI English catalog before release.

**Trigger surface:** Session desktop panels, control buttons, accessibility labels and keyboard shortcut labels.

**Incident:** The v0.14.11 release suite found 14 hardcoded desktop/control labels even though all locale catalogs had matching keys. Catalog parity alone did not detect untranslated source text.

**Enforcement:** apps/web/scripts/audit-i18n.test.mjs runs the strict source/catalog audit. The repaired source passes with zero hardcoded findings; the frontend production build prerenders supported locales.
