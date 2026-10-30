# Stage 2: goals as durable TypeScript programs

Status: planning, 2026-10-20. Nothing here is built. Stage 1 (`system.md`) is merged.

## The idea

A goal's program is a TypeScript file in its folder. It uses the same
programming model as Claude Code's Workflow tool (`agent`, `parallel`,
`pipeline`, `phase`, typed results), made durable for goals that wait weeks
for people and events.

```ts
// Goals/bank-close/goal.ts
import { goal } from '@kortix/sdk/workflows'

export default goal({
  objective: 'Old business bank account fully closed',
  criteria: ['Written closure confirmation', 'No charges for 30 days after closure'],
  constraints: ['Remaining balance goes to the main operating account'],

  async run(ctx) {
    await ctx.parallel([
      ctx.agent('move-balance', 'Move the remaining balance'),
      ctx.agent('cancel-cards', 'Cancel every card and auto-debit'),
    ])
    await ctx.agent('request-closure', 'Request closure in the bank's app')
    while (true) {
      const mail = await ctx.waitFor('bank-email', { timeout: '1d' })
      if (mail) break
      const next = await ctx.agent('decide-chase', 'The bank has not confirmed. What now?', {
        schema: { action: ['chase-email', 'chase-phone', 'ask-owner', 'wait'], reason: 'string' },
      })
      if (next.action === 'ask-owner') await ctx.ask('owner', next.reason)
      else if (next.action !== 'wait') await ctx.agent(next.action, `Do: ${next.action}. ${next.reason}`)
    }
    await ctx.sleep('30d')
    await ctx.verify()
  },
})
```

The LLM writes the script and decides inside steps (typed `agent()` results).
The script holds the control flow. It is deterministic over recorded results:
a model's answer, once recorded, replays identically.

## Building blocks, all through `@kortix/sdk`

| Block | Backed by | Wakes the goal |
|---|---|---|
| `ctx.agent(name, prompt, opts)` | session create, unattended; `schema` for typed results | rooms idle notice when the session's turn ends |
| `ctx.room()`, agents messaging each other | agent rooms (PR #10308, flag `agent_rooms`) | a message addressed to the goal |
| `ctx.ask(person, text)` | rooms DM or the person's bound Slack thread | the person's reply |
| `ctx.sleep()`, timeouts | reminders / scheduler rows | the timer |
| `ctx.waitFor()`, `ctx.watch()` | monitors (24/7 code), webhooks, app events, email | the trigger |
| `ctx.parallel()`, `ctx.map()` | several `agent()` calls | each one's idle notice |
| `ctx.verify()` | a verifier session + the API's done gate | — |

Open API addition: on-demand agent definitions
(`ctx.agent(name, prompt, { define: { instructions, model, tools, skills, connectors } })`).
Today session create accepts only an agent declared in `kortix.yaml`
(`agent_name` in `SessionCreateInputSchema`, `packages/api-contract/src/index.ts`).

## Where it lives

```
Goals/<slug>/
  goal.ts               the program
  .run/journal.jsonl    every step result, wait and event (only the runtime writes)
  .run/versions/        every earlier goal.ts, who changed it, why
  docs/  evidence/  notes.md
```

The CLI (inside a sandbox, through `/drives`) and the SDK (outside, through the
Files API) read the same folder. Outside the folder the API keeps one pointer
row per goal: project, folder, what it waits for. It holds no state and can be
rebuilt by scanning folders.

## How it starts, runs, changes

- **Start:** the user gives the objective; a coordinator session writes
  `goal.ts`; `kortix goals start` validates it, records the pointer and runs it
  once.
- **Run:** on each wake event the runner reads `goal.ts` and the journal,
  replays recorded steps by **name**, runs until the first unresolved `await`,
  records it, registers its wake source and exits. Nothing runs while a goal
  waits.
- **Where the runner executes (recommended):** the Kortix API's background loop,
  inside a QuickJS sandbox (`@earendil-works/pi-codemode`, already a dependency:
  no network, no files, no clock). The API runs several replicas with leader
  election (`apps/api/src/shared/leader-election.ts`); state is in rows and the
  journal, so a crash loses nothing. Alternative: run `kortix goals tick` in a
  control session per wake (no user code in the API, but 10–30 s of box boot per
  wake). A Cloudflare Worker is possible but adds a subprocessor and a second
  deploy pipeline; not now.
- **Change:** edit `goal.ts`, then `kortix goals update`. The API type-checks
  it, requires that it still ends through `ctx.verify()`, holds changes to
  criteria, constraints, budget or irreversible actions for the owner's
  approval, and stores the previous version. Finished steps with unchanged
  names are reused; new or renamed steps run.
- **"Deploy"** is saving and validating the file. There is no build.

## Enforcement: on effects, in the API

| Rule | Where |
|---|---|
| Only the runtime writes `.run/` | Files permissions: `.run/` mounted read-only into sandboxes |
| `done` only with an independent PASS and evidence | API, at the done call |
| An approval or answer only from the real person | API: events from that person's verified channel identity |
| Irreversible actions only after approval | API, before the step runs |
| A step's agent gets only that step's connectors, secrets, budget | API, at session create |
| Plan edits keep verification and protected items | API validator, at update |
| A goal always wakes | API: every wait is a scheduler or trigger row |

The sandbox turn-end check from stage 1 stays as a backstop.

## Other uses

- **Software factory:** one workflow defines what happens to one issue (found →
  groomed → worked → PR → merge gate → merged → verified on dev); each issue is
  one running copy started by the source signals. Today it is 16 cron triggers
  and about 8,900 lines of skill prose in `company/engineering/`.
- **TypeScript-first Kortix:** `kortix.config.ts` compiling to today's manifest
  (the AWS CDK / Pulumi pattern). A separate initiative; see `decisions.md`.
