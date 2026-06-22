---
name: migrate-icons-to-mynaui
description: Migrate apps/web icon imports from lucide-react and react-icons to @mynaui/icons-react (Solid preferred). Use when consolidating the icon library, replacing lucide/react-icons usages, adding a new lucide→mynaui mapping, or running/extending the icon codemod at scripts/migrate-icons-to-mynaui.ts.
---

# Migrate icons to @mynaui/icons-react

A single codemod migrates every `lucide-react` and `react-icons` import in
`apps/web` to `@mynaui/icons-react`, **preferring the Solid variant**, and drops
both libraries from `apps/web/package.json` once nothing imports them.

## Run it

```sh
bun scripts/migrate-icons-to-mynaui.ts --dry-run   # report only, no writes
bun scripts/migrate-icons-to-mynaui.ts             # apply in place
```

Then review `scripts/MIGRATION_REPORT.md` and verify:

```sh
grep -rE "from ['\"](lucide-react|react-icons)" apps/web/src   # expect: no output
(cd apps/web && ./node_modules/.bin/tsc --noEmit -p tsconfig.json)
bun test scripts/migrate-icons-to-mynaui.test.ts
(cd apps/web && bun test src/lib/utils/icon-utils.test.ts)
```

## How it works (key facts)

- **Import-only, alias-preserving.** Every icon is imported aliased back to its
  original local name (`CogSolid as Settings`), so JSX/usage sites are **never
  touched** — the safest possible transform. The codemod uses the TypeScript
  compiler API (resolved from `apps/web/node_modules`), so multiline / aliased /
  mixed type+value / barrel `export { … } from` forms all parse correctly.
- **Idempotent + merges.** Re-running is a no-op. New specifiers merge into a
  file's existing `@mynaui/icons-react` import instead of adding a duplicate.
- **Solid preferred, outline fallback.** A lucide/react-icons name resolves to
  `<Base>Solid` if it exists, else the outline `<Base>`, else (no base) the run
  fails loudly naming the file.
- **Type imports are not icons.** `LucideIcon` / `LucideProps` (even imported
  without `type`) and `react-icons/lib` `IconType` all become the mynaui `Icon`
  type.
- **Runtime / dynamic icons.** `lucide-react/dynamic`'s `DynamicIcon` is
  repointed at `@/components/ui/dynamic-icon` (a mynaui-backed resolver). The
  lucide `{ icons }` registry in `apps/web/src/lib/utils/icon-utils.ts` is backed
  by `mynauiIconRegistry`. Both translate previously-stored lucide icon-name
  strings through the same alias map, so existing data still resolves.

## Source of truth: the mapping

`apps/web/src/lib/icon-migration-map.ts` is the single mapping module, imported by
the codemod, the runtime resolver (`dynamic-icon.tsx`), and `icon-utils.ts`. It
holds only **non-identity** entries (mynaui base name, no `Solid` suffix):

- `LUCIDE_TO_MYNAUI` — lucide name → mynaui base
- `REACT_ICONS_TO_MYNAUI` — react-icons name → mynaui base
- `FORCED_MAPPINGS` — names with no real mynaui equivalent (flagged for review)

Direct matches (lucide `Calendar` → `CalendarSolid`) and simple normalizations
(strip `Icon` suffix / trailing digit / `Cw`·`Ccw`) are resolved algorithmically
and intentionally omitted from the map.

### Add or change a mapping

1. Find a real mynaui name: grep the package's `.d.ts`
   (`node_modules/.pnpm/@mynaui+icons-react@*/node_modules/@mynaui/icons-react/dist/myna-icons-react.d.ts`)
   for `declare const <Name>`. Every base has a `<Name>Solid` twin.
2. Add `LucideName: 'MynauiBase'` (no `Solid`) to the right map. If it's a
   best-effort "closest" choice, also add the original name to `FORCED_MAPPINGS`.
3. Re-run with `--dry-run`. The codemod **fails loudly** on any name with no
   mynaui base — that's your signal to add a mapping.

## Review checklist (forced mappings)

`FORCED_MAPPINGS` are best-effort because mynaui has no equivalent (e.g.
`Bot`→`Sparkles`, `Cpu`→`Microchip`, `Workflow`→`Share`, `Gauge`→`Activity`).
After running, open `MIGRATION_REPORT.md` → "Forced mappings" table and
eyeball each one in the UI; swap the mapping if a better icon fits, then re-run.

## Files

- `scripts/migrate-icons-to-mynaui.ts` — the codemod (exports `transformSource`)
- `scripts/migrate-icons-to-mynaui.test.ts` + `scripts/__fixtures__/test.tsx` — golden test
- `apps/web/src/lib/icon-migration-map.ts` — the mapping (source of truth)
- `apps/web/src/components/ui/dynamic-icon.tsx` — mynaui dynamic resolver
- `apps/web/src/lib/utils/icon-utils.ts` — runtime registry + name validation
- `scripts/MIGRATION_REPORT.md` — generated report
