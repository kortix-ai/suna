---
name: learnings
description: "The project's episodic memory: a timestamped ledger of rules paid for with real outages and near-misses, one entry per incident. Load WHENEVER you write or review a DB migration or schema change, touch deploy/release workflows (.github/workflows/deploy-*, promote.yml, vercel config), plan a promote/release, respond to a prod incident, or when another skill references a learning. ALSO load after resolving any incident or near-miss: it must leave a new ledger entry in the same session."
---

# Project learnings: the episodic ledger

Every rule this repository paid for with downtime or a near-miss is one entry in a
timestamped, append-only ledger. The ledger is the full history, in the order it was
learned.

| Path | What it is |
| --- | --- |
| `MEMORY.md` | The index. One line per entry, newest first: recorded time (UTC) and the rule. Generated. |
| `entries/<YYYY-MM-DDTHHMMSSZ>-<slug>.md` | One entry. The filename timestamp is when it was recorded. |
| `scripts/new-entry.sh` | Starts a new entry stamped with the current UTC time and rebuilds the index. |
| `scripts/index.sh [--check]` | Rebuilds `MEMORY.md` from `entries/`, or fails if it is stale. |

Entries recorded before 2026-09-25 were split out of the old single-file register. Their
`recorded` time is the commit that first wrote them (`commit` in the frontmatter).

## Recall: before you touch a surface

1. Search the index and the full text for the surface you are about to change:
   ```bash
   grep -i '<keyword>' .agents/skills/learnings/MEMORY.md
   grep -ril '<keyword>' .agents/skills/learnings/entries/
   ```
   Use the words of the surface: `migration`, `CONCURRENTLY`, `deploy-dev`, `promote`,
   `wake`, `Stop`, `gateway`, `preview`, the file or route name.
2. Read every matching entry in full. Obey its **Rule**, and keep its **Enforcement** green.

Done when every entry that names the surface you touch has been read.

## Record: after an incident or near-miss resolves

Record in the same session. An incident that leaves no entry is not finished.

1. Start the entry:
   ```bash
   .agents/skills/learnings/scripts/new-entry.sh "<the rule, as an imperative>" [incident-date]
   ```
2. Fill the four sections the script writes:
   - **Rule:** the imperative a developer can obey while coding.
   - **Trigger surface:** what someone is doing when it applies.
   - **Incident:** date, version or PR, blast radius, in one to three lines.
   - **Enforcement:** the test, lint, or CI gate that goes red when the rule breaks. An
     entry with an enforcer is a fact. One without is a TODO: name the enforcer to build.
3. Commit the entry and `MEMORY.md` in the same commit.

Done when `scripts/index.sh --check` exits 0 and the entry is committed.

## Ledger rules

- **Append-only.** After an entry merges, its text does not change. When a rule changes,
  or an Enforcer moves or is retired, record a new entry. Put
  `supersedes: <entry filename>` in its frontmatter and state what changed.
- **One entry, one file, one timestamp.** `recorded` in the frontmatter matches the
  filename. It is the time of recording, never the incident date. The incident date goes
  in `incident_date`.
- **`MEMORY.md` is generated.** Run `scripts/index.sh` after any entry change. It merges
  with git's `union` driver, so two branches that each add an entry do not conflict. After
  a merge, run `index.sh` to restore the order. `tests/unit/learnings-ledger.test.ts` fails
  on a stale index or a malformed entry.
- **Keep an entry short: about 8 to 20 lines.** Deep detail belongs in the PR or the RCA.
  Link to it.
- **Synthetic identifiers only.** An entry is committed text, so the AGENTS.md customer-data
  rule applies. Write "a customer", "an enterprise workspace", `<session_id>`.
