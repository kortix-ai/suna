---
description: First-run onboarding — gatekeeper until unlock. ~5 min target. Seeds USER.md/MEMORY.md; skippable via UI or chat.
agent: general
---

# Onboarding

**Gatekeeper until unlock.** The dashboard stays in onboarding mode until `ONBOARDING_COMPLETE` is set (Phase 8). Users can skip anytime (dashboard **Skip** button or explicit skip in chat — see Skip Handling).

## Time and question budget

- **Target: under 5 minutes** of user time.
- **Aim for ≤6 `question` tool calls** on the happy path (not counting Missing API Key Protocol, skip confirmations, or the single Phase 2 correction follow-up).
- Prefer **advancing** over follow-ups. If an answer is short, write what you have to memory and **move on** — note gaps in `MEMORY.md` as TODOs.

## Goals

1. **Understand them** — who they are, what they do, what they’re building
2. **Map their stack (light)** — main tools only; exhaustive inventory is **not** required in onboarding
3. **Connect when quick** — OAuth/API only when it fits time; defer the rest to post-dashboard
4. **Seed memory** — write to `.kortix/USER.md` and `.kortix/MEMORY.md` **after each phase** (minimum updates). Final consolidation in Phase 8.

## Context

- LLM API keys already configured pre-onboarding. Do NOT ask about them.
- Use `question` for choices and text prompts (interactive UI).
- **Write memory as you go**, not only at the end.
- **Adapt language** to the person (student vs founder, etc.).
- **Scraping fallback:** `scrape_webpage` → `webfetch` → `web_search`. LinkedIn: `web_search` only (never scrape LinkedIn).

---

## Skip Handling

### Firm skip (instant unlock)

If the user says "skip" firmly, repeats it, or is clearly done — do not push back:

1. Brief line: "Unlocking now — you can finish setup anytime."
2. Write whatever you have to `USER.md` and `MEMORY.md` (minimal is OK).
3. Run **Phase 8** unlock curls immediately.

### Soft skip (one gentle nudge)

If softer ("later", "just let me in", "skip the tools part"):

1. One short value line, then `question`:

`question({ header: "Skip onboarding?", question: "Finish in under a minute, or go to the dashboard now?", options: [{ label: "Let me in", description: "Skip for now" }, { label: "Keep going", description: "Continue" }] })`

2. "Let me in" → memory minimal write → **Phase 8** unlock.
3. "Keep going" → resume.

**Second skip request of any kind → instant unlock, no more nudges.**

---

## Setup

Before the first user-visible message:

1. `project_create(name: "workspace", description: "Main workspace", path: "/workspace")`
2. `project_select(project: "workspace")`

If create fails because "workspace" exists, only `project_select`. Do NOT `project_list` or ask which project.

---

## Phase 1: Welcome & Identity

Warm, direct — one question only.

> Hey — I'm your Kortix agent. I have a full computer: browse, code, connect services, scheduled tasks. Quick setup (~5 min) so I know you — skip anytime.

**One `question`:**

`question({ header: "Who are you?", question: "Your name and where you work or what you're building (company, role, project — whatever helps). I'll look up public context next.", options: [] })`

Derive **preferred name** from the first line (first name or how they sign off). Do **not** ask "what should I call you" separately.

**→ `USER.md`:** preferred name, raw answer.
**→ `MEMORY.md`:** stub line that you’ll refine in Phase 2–3.

---

## Phase 2: Research Them

**Immediately** after Phase 1, run **up to 3** parallel `web_search` calls (same rules as before: name + company, LinkedIn via search, company site if useful). Then light scrape only where it helps (GitHub, company site — not LinkedIn pages).

**One confirm `question`:**

`question({ header: "Quick check", question: "[Short compiled: role, company, background, links — or say searches were thin]", options: [{ label: "That's me", description: "Looks right" }, { label: "Not quite", description: "I'll correct" }] })`

If "Not quite": **at most one** follow-up `question` with `options: []`, then proceed — do not loop.

If searches were empty: say so honestly; **one** optional free-text `question` to fill gaps, then proceed.

**→ `USER.md`:** confirmed identity, links.
**→ `MEMORY.md`:** company/project sketch from research.

---

## Phase 3: What They’re Building

If Phase 2 already captured product/company well, **skip this phase** (no `question`) and only append a line to `MEMORY.md`.

Otherwise **one `question`:**

`question({ header: "What are you building?", question: "Main focus right now — company, side project, research, freelance. One or two sentences (link optional).", options: [] })`

**→ `MEMORY.md`:** building / project / stage (brief).

---

## Phase 4: Map Their Stack (light)

**One `question`** — checkboxes are faster than typing; still counts as a single `question` call:

`question({ header: "Your tools", question: "What do you use most? Pick any that apply — we can add more later.", multiple: true, options: [ { label: "Connect later", description: "Skip connections for now" }, { label: "GitHub", description: "" }, { label: "Slack", description: "" }, { label: "Gmail", description: "" }, { label: "Google Workspace", description: "" }, { label: "Notion", description: "" }, { label: "Linear", description: "" }, { label: "Discord", description: "" }, { label: "Stripe", description: "" }, { label: "Vercel", description: "" }, { label: "AWS", description: "" }, { label: "Supabase", description: "" } ] })`

The tool may allow free text for unlisted tools — if so, treat those like selected labels.

**Connector work (time-boxed):**

- If **only** "Connect later" or nothing selected → note in `MEMORY.md`, go to Phase 5.
- Otherwise: `connector_list(filter="")`, then **at most 2** quick OAuth/connect attempts (Pipedream `search` → `connect` pattern). More tools stay **pending** in `MEMORY.md` — do not connect everything in this session.

**→ `MEMORY.md`:** tools list, connected vs pending.

---

## Phase 5: What They Need

**One `question`:**

`question({ header: "What should I focus on?", question: "What do you want help with first — coding, research, automation, writing, ops? One sentence is enough.", options: [] })`

**→ `USER.md`:** primary use / focus.
**→ `MEMORY.md`:** goals line.

---

## Phase 6: Capabilities (no demo by default)

**No `question` in this phase.** Send **one short message** (3–5 sentences): what you can do **for them** based on what you learned — concrete, not a generic feature list. Mention they can ask for a deeper demo anytime **after** the dashboard.

**Do not** offer Phase 7 demo choice here — default is **skip live demo** to save time.

**→ `MEMORY.md`:** one-line note that capabilities were summarized (optional).

---

## Phase 7: Live demo (off by default)

**Skip entirely** unless the user **explicitly** asks for a demo during onboarding ("show me", "can you try something").

If they do: pick **one** task, **under 60 seconds**, use `show` for results — same persona hints as before (founder / dev / marketer / student). Then continue to Phase 8.

---

## Phase 8: Final memory & unlock

### Final memory write

Read `USER.md` and `MEMORY.md`, then **integrate and clean** (one pass). Minimum expectations:

- **`USER.md`:** preferred name, name, role/org, background, links, focus, onboarding date.
- **`MEMORY.md`:** project/building, tools (connected/pending), goals, any TODOs for later setup.

**Verify:** read files back after writing.

### Fire the unlock

**CRITICAL: EXACTLY `http://localhost:8000`. No other host.**

```bash
curl -s -X POST "http://localhost:8000/env/ONBOARDING_COMPLETE" \
  -H "Content-Type: application/json" -d '{"value":"true"}'
curl -s -X POST "http://localhost:8000/env/ONBOARDING_USER_NAME" \
  -H "Content-Type: application/json" -d '{"value":"PREFERRED_NAME"}'
curl -s -X POST "http://localhost:8000/env/ONBOARDING_USER_SUMMARY" \
  -H "Content-Type: application/json" -d '{"value":"ROLE at COMPANY — PRIMARY_USE_CASE"}'
curl -s -X POST "http://localhost:8000/env/ONBOARDING_COMPLETED_AT" \
  -H "Content-Type: application/json" -d "{\"value\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
```

**Verify:** `curl -s http://localhost:8000/env/ONBOARDING_COMPLETE` must show success / `"true"`. Retry if not.

Close briefly: they’re in; memory will carry over next session.

---

## Missing API Key Protocol

When a tool returns `"Error: FOO_API_KEY not set."`:

1. Identify the key and doc URL.
2. **One** `question` with Skip option; if skipped → note in `MEMORY.md`, continue (do not block Phase 8 unless product requires that key for unlock — it does not).
3. If pasted → `curl -X POST http://localhost:8000/env/KEY_NAME -d '{"value":"...","restart":true}'` → retry once.

**Never silently ignore** missing keys for operations you attempt — but **do not** add extra onboarding rounds.

---

## Rules

1. **Unlock only in Phase 8** (except skip paths → same curls).
2. **Respect skip** (dashboard or chat) per Skip Handling.
3. **Write memory after each phase** you actually run; Phase 8 consolidates.
4. **Never scrape LinkedIn** — `web_search` only.
5. **≤6 `question` calls** on the happy path; Phase 2 "Not quite" allows **one** extra; skip flows may add one confirm; Phase 3 may add zero if skipped.
6. **No category sweep**, no "connect every service", no mandatory live demo.
7. **Save secrets immediately** when the user provides keys (`curl` to `/env/...`).
8. **VERIFY memory writes** when possible.

$ARGUMENTS
