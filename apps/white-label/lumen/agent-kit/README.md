# Lumen agent kit

Lumen's own agents, skills and tools. Lumen installs this folder into every
firm's Kortix project (`convex/kitInstall.ts`) and upgrades a firm on its next
run when `kit.json` changes. Nothing here is Kortix platform code: the
platform runs it like any other project's agents and skills.

| Path | Installed as |
|---|---|
| `agents/_rules.md` + `agents/<name>.md` | The agent's prompt (`updateAgentConfig`), rules first |
| `skills/<name>/SKILL.md` | `skills/<name>/SKILL.md` in the project repo |
| `lumen-kit/` (minus `fixtures/` and the selftest) | `lumen-kit/` in the project repo; agents run `python3 /workspace/lumen-kit/bin/lumen …` |
| `lumen-kit/schemas/` | Also bundled into Convex: Lumen validates every result file with ajv against the same schemas |
| `shared/cite-vectors.json` | Quote normalization cases; the Python selftest and `tests/unit/cite.test.ts` both run them |
| `evals/` | Not installed: the answer key, cases and scorer |

## Change something

1. Edit the prompt, skill or tool.
2. Bump `kit.json` `version` (patch: wording; minor: a new command, skill or
   optional field; major: a result schema change old outputs do not meet).
3. `bun scripts/kit-bundle.ts` (rewrites `convex/kit/bundle.generated.ts` and the hash).
4. `cd agent-kit/lumen-kit && python3 -m lumen_kit.selftest` and
   `bun test tests/unit/kit-bundle.test.ts tests/unit/cite.test.ts`.
5. `pnpm --filter @kortix/white-label-lumen eval` and compare the table with
   the last one in the PR.

Firms pick up the new kit on their next run (Settings → Firm shows the
version). Sessions that are running keep the kit they started with.

## The run contract

Lumen writes `input.json` (schema `input`) into
`/drives/company/Lumen/Runs/<runId>/<batchId>/`. The agent writes each result
with `lumen result write` into `out/` (review rows as `out/rows/<docId>.json`;
one `out/answer.json`, `out/issues.json`, `out/report.json` or `out/draft.json`
for the other kinds; files a result names, such as `redline.docx`, go next to
it) and finishes with `lumen result done`, which
refuses to write `done.json` while any result is invalid. A citation is
`{doc_id, a: "p<page>.<n>", quote}`; `lumen cite check` and Lumen apply the
same rules.
