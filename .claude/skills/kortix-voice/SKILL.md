---
name: kortix-voice
description: "Kortix brand voice + interface copy rules. Load this WHENEVER you write or edit user-facing words in apps/web — UI labels, buttons, empty states, onboarding, modals, toasts, headings, marketing/landing copy, or docs framing — and whenever deciding how to phrase a feature for non-technical vs technical readers. Enforces: plain language by default, technical detail is opt-in, the command-center vocabulary, and the banned-words list. Pairs with kortix-design-system (how it looks) — this is how it reads. Canonical positioning lives in suna/COMMS.md."
---

# Kortix Voice

How Kortix *reads*. The design system governs how it looks; this governs the words. The canonical positioning is **`suna/COMMS.md`** — when in doubt, that doc wins; this skill is how you apply it in the product.

## The one rule

> **Plain language by default. Technical detail is opt-in.**

A non-technical founder must understand every default surface without knowing what a repo, branch, sandbox, or commit is. The technical truth still exists — it lives one layer down: behind an **"Advanced"/"For developers"** disclosure, in an **"Under the hood"** callout, or in the **Reference** docs. Never lead with jargon; never hide the outcome behind it.

## Voice

- **Outcome first.** Say what the user gets, then (optionally) how. "Your agent drafts the report" > "Spawns a session that runs the prompt."
- **You, active, short.** Address the user as "you". Active voice. Short sentences. Sentence case for everything (headings, buttons, labels) — not Title Case.
- **Calm and confident.** Founder-grade, plain. No hype, no fear, no filler.
- **Specific, not salesy.** Concrete nouns and verbs over adjectives.

## Vocabulary (the command center)

Use: **command center · agents · skills · integrations · connections · automations · sessions · projects · accounts · memory · deliverables · on-demand / human-assisted / automated · review · merge · open · own your infrastructure · 24/7 · compounds.**

Avoid (banned):
- **Product mislabels:** chatbot · copilot · "assistant" (for the product) · "AI employee" (singular).
- **Hype/filler:** simply · just · seamless · powerful · blazing · effortless · revolutionary · "in seconds".
- **Fear:** never scare the user into a click.
- **Specific dead phrases:** "no Git account required" · "managed repo / sandbox snapshot / default branch" *on a non-technical surface*.
- **The legacy name:** do not write **"Suna"** in any new copy. The product is **Kortix**.
- **Runtime pinning:** the sandbox runtime is *becoming pluggable* — don't hard-pin or prominently brand it (e.g. "powered by OpenCode") in product/marketing copy.

## License wording

Always say **"open" / "source-available"**. Never "MIT", never "100% open source".

## Plain ↔ technical glossary

Lead with the plain term; reveal the technical one only in Advanced/Under-the-hood/Reference.

| Concept | Plain (default UI) | Technical (opt-in) |
| --- | --- | --- |
| Project | a workspace for one company, product, or idea | a git repository + `kortix.toml` |
| Session | one task you hand your agent, in its own safe space | an isolated sandbox VM on a branch |
| Change request | the agent's proposed work, for your review | a branch merged into the default branch |
| Keep / approve | "merge" / "keep the work" | merge the change request |
| Secret | a key your agent needs, stored safely | encrypted env var injected at runtime |
| Connection | connect a tool your agent can use | `[[connectors]]` + the Executor |
| Trigger | run a task on a schedule or event | `[[triggers]]` (cron / webhook) |
| Account | your account (personal or team) | the tenant; roles owner/admin/member |

## Before → after

| ❌ Don't | ✅ Do |
| --- | --- |
| "Start with a private managed repo. Existing GitHub repos can be imported." | "A dedicated space for one company, product, or idea." |
| "Creates a private managed repo, seeds the starter, builds the first sandbox snapshot." | "We set up your project, ready to use." |
| "Kortix-managed repository" | "Start fresh (recommended)" |
| "Import existing GitHub repo" (prominent) | tuck under "Already have code? (for developers)" |
| "Run agents in disposable VM sandboxes against your GitHub repos." | "A workforce of AI agents that does the real work across your tools." |
| "Powered by OpenCode" | (omit; the runtime is becoming pluggable) |

## Technical surfaces are different

Developer-facing surfaces — the **Reference** docs, the CLI, `kortix.toml`, code comments — should be **precise and dense**, not dumbed down. Plain-first applies to the *product UI and the conceptual/marketing layer*; the reference layer states exact fields, flags, and behavior. Accuracy always beats simplicity: never make a claim the code doesn't back (verify against source).

## Checklist before shipping copy

1. Could a non-technical founder understand it with zero jargon? If not, simplify or move the jargon behind a disclosure.
2. Sentence case? Active voice? Outcome-first?
3. No banned words? No "Suna"? No runtime pinning?
4. Is every factual claim true to the code?
5. Does it match `COMMS.md` positioning and the glossary above?
