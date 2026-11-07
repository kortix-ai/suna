# Work in progress: plans, designs, open thoughts

The ledger in `entries/` records rules paid for with incidents. This folder holds
the other half of the project's memory: the thinking behind work that is
planned, in flight, or parked, so another person or agent can pick it up.

- One folder per topic. Its `README.md` starts with frontmatter (`title`,
  `status`, `owner`, `updated`), then the problem, the files, and how to pick
  it up.
- Living documents: edit them in place. Keep a dated `decisions.md` when a topic
  has decisions.
- Same data rules as everywhere: no customer names, personal data, or real
  prod IDs.
- When the work ships, keep the folder and set `status` to what shipped and
  where (PR, merge SHA).

## Topics

| Topic | Status |
|---|---|
| [`opencode-history-recovery/`](opencode-history-recovery/README.md) | big-store fix on dev (`recover-opencode-history`): copy OpenCode-era conversations that never reached the session log off archived boxes; prod run after the release that ships the fix |
| [`harness-architecture-diagram/`](harness-architecture-diagram/README.md) | designed, not built: the home-page harness diagram (mock + box copy); placement A (own section) or B (replaces the Framework tab) open |
| [`project-repository-access/`](project-repository-access/README.md) | phase 1 on dev (#11492 partial object store, #11501 named image steps); target decided: one Platinum volume per project (git inside, external repos only a sync target); interim: box checkouts off the API, branch-scoped refreshes, shared config snapshot |
| [`stateless-sessions/`](stateless-sessions/README.md) | target decided: a session is its workspace + transcript on its volume, the transcript file is the one source of truth, the sandbox is disposable; stage 1 on dev (#11503), the rest not started |
| [`long-horizon-runtime/`](long-horizon-runtime/README.md) | planned (`my-kortix-v2`), phase 1 decided: retrieval from the full record instead of compaction, an orchestrator that never waits, background commands, workers that own their threads |
| [`long-horizon-follow-through/`](long-horizon-follow-through/README.md) | on dev (#11332 bd2d6ac89c, #11344, #11347, #11351): every agent sets its own wake-up after each wait: loops, session event triggers, App events |
| [`my-kortix-multi-agent-parity/`](my-kortix-multi-agent-parity/README.md) | building (`my-kortix-v2`): messages between sessions, agent teams (flag `agent_teams`), agent board, workflow controls; async orchestration |
| [`goals-and-workflows/`](goals-and-workflows/README.md) | stage 1 merged on dev (flag `goals`); stage 2 planning |
| [`email-cost-passthrough/`](email-cost-passthrough/README.md) | parked: meter managed Resend inboxes and emails per account |
| [`connector-policy-sets/`](connector-policy-sets/README.md) | in progress: one connector profile, a named rule set per agent |
| [`kortix-yaml-versionless/`](kortix-yaml-versionless/README.md) | building (`one-schema`): one versionless kortix.yaml, hard cut of v1/v2/TOML, broken entries off at run time; zod single source next |
| [`image-generation/`](image-generation/README.md) | in progress (branch `image-gen`): `image_gen` tool, gpt-image-2 on a connected ChatGPT plan |
| [`platinum-machines-apps/`](platinum-machines-apps/README.md) | planning: the sandbox becomes a Machine, Apps move into Platinum; 7 decisions open; parked idea: bare-metal marketplace |
| [`workspaces/`](workspaces/README.md) | planning: Project → Workspace, 1 account = 1 project (the Slack model); D2–D4 open |
| [`prompt-identity/`](prompt-identity/README.md) | building (`prompt-identity`): one id per prompt, visible from accept to answer |
| [`my-kortix-account-actions/`](my-kortix-account-actions/README.md) | planned: account-level My Kortix actions as server-side held approvals |
