# Pi runtime parity audit

Updated: 2026-09-08. Canonical branch: `pi-worker`.
Draft PR: [#6998](https://github.com/kortix-ai/suna/pull/6998).
Preview: [pi.kortix.com](https://pi.kortix.com).

**Production replacement: NOT YET.** The implemented foundation is usable on the
preview. The missing capabilities below remain part of the objective.
A passing deployment workflow does not prove the full preview test suite ran.
Push deployments deliberately skip that suite; run target-full separately.

## Runtime selection and ownership

- YAML v3 selects Pi, including when `runtime` is omitted or `pi_worker` is off.
- YAML v2 selects OpenCode. Contradictory runtime declarations fail validation.
- Pi runs in the worker. Its six workspace tools call the environment daemon.
- The environment owns the workspace, shell, Git, PTY, and preview processes.
- Text-only and worker-only tools leave an absent environment absent.
- PostgreSQL owns conversation state outside both sandboxes. No Durable Objects run.
- Working files stay in the environment. Shared filesystem services expose an
  independent API/SDK/CLI contract; they do not mount a disk in either runtime.
- Existing sessions retain their installed configuration commit. A legacy worker
  recovers that commit from its installed bundle, not the current branch HEAD.

Environment upgrades install an execution-only daemon. Its health must report
`workload: environment`, `opencode: disabled`, and `runtimeReady: true`.
The upgrade preserves workspace bytes and the selected branch. It excludes
provider PID 1 from process control. Preview `a218bc6` verifies zero Pi workers
and zero OpenCode servers in the upgraded environment. Its file hash, branch,
and commit remain unchanged.

## Implemented capability groups

“Verified” below names an existing proof. It does not imply that every permutation
of each feature or the remaining parity matrix passed.

| Capability | Implementation | Verification |
|---|---|---|
| Text, streamed responses, status, Stop, next prompt | Durable admission, turn ownership, wire events, and SDK transport | HTTP recovery suites; browser incremental rendering and Stop |
| Questions | Native tool, existing web cards, reply/reject, durable checkpoints | Reply failure, reload, worker replacement, dismissal, multi-question browser journeys |
| Permissions | Tool policy, URL/path patterns, once/always/reject, durable checkpoints | Policy, persistence failures, replacement, closed-boundary and browser tests |
| Per-agent behavior | Prompt, model at session creation, generation settings, step limit, permission policy | Compiler, HTTP, and distinct reviewer/operator live sessions |
| Custom Pi code | Static module and pinned dependencies in the immutable bundle | Real compiled artifact, custom tools, initialize/cancel/shutdown and native lifecycle hooks |
| Custom-code isolation | Node permission model, scoped remote environment capability | Denied local filesystem/process access and real Node artifact tests |
| Commands | Compiled templates, arguments, substitutions through environment tools, instruction ordering | Exact-commit compiler and live command UI |
| Skills | Compiled instruction bodies and environment support files | Compiler, policy, live instruction/support-file markers |
| Todos | Read/write tools, wire events, restored state | Worker routes and visible plan tests |
| Web search | Gateway-backed web search | Live tool and result verification |
| Web retrieval | `webfetch`: public HTTP(S), Markdown/text/HTML, permissions, redirects, Stop, size limits | 43 focused tests; real HTTPS under Node confinement; real preview UI tool call and stopped environment |
| Files, shell, Git, PTY, previews | Environment RPC and native daemon routes | Workspace isolation, native daemon boot, preview upgrade with unchanged files and zero runtime processes |
| History while stopped | Durable transcript mirror and worker restoration | Full historical message identity preservation |
| Public conversation while stopped | Sanitized worker transcript or PostgreSQL mirror | Preview: 24 messages preserved byte-for-byte as sanitized envelopes; anonymous HTTP 200, revoked HTTP 410 |
| Worker/environment lifecycle | Distinct runtime principals, restore/stop/replacement, lease fencing | Race, credential, immutable identity, and live restart tests |
| Context compaction | Manual and automatic checks before new prompts and between tool rounds; bounded retention and complete display history | HTTP threshold, Stop, retry, queue, replacement, oversize, and crash tests; real Luna with an 8,192-token fixture window, one tool execution, saved summary, exact restart, and recall; preview manual-compaction UI |
| Prompt controls | `system`, `noReply`, tool controls | Parser, durable replay, and HTTP tests |
| Reasoning variants | Compiled defaults, per-prompt/command settings, worker capability projection, session-scoped React selection | Eight live SDK calls; preview UI High/None/Auto payloads and provider results; reload, nine-message stop/resume, and question recovery |

Custom Pi modules are supported. OpenCode plugins are not automatically Pi
extensions. The native Pi lifecycle surface is documented in
[PI_CUSTOM_AGENTS.md](./PI_CUSTOM_AGENTS.md).

## Remaining user-facing capabilities

| Capability | Current behavior | Required work |
|---|---|---|
| File/image attachments | Pi rejects non-text prompt parts; hosts gate upload controls | Durable bounded attachment storage, model conversion, replay, and UI journeys |
| Provider context-overflow recovery | Threshold compaction runs before new prompts and between tool rounds | Recovery when one input or tool result already exceeds the provider window; full-size preview proof remains blocked by ingress |
| Rewind and restore | Raw revert/unrevert returns 501 | Atomic conversation branch change plus file-effect semantics, recovery, and SDK/UI verification |
| Session fork and children | No durable fork or child execution contract | Child runtime identity, copied history boundary, environment policy, billing, and UI |
| Subagents / coordinator | Pi exposes the selected compiled agent | Durable child execution and the equivalent coordinator behavior |
| MCP configuration | No native Pi MCP loader | Governed compiled config, remote/stdio execution placement, authorization, cancellation, and discovery |
| Live model and agent switching | Config is fixed; API and host controls reject unsupported changes | Explicit runtime reconfiguration preserving history and grants, or an accepted product divergence |
| Structured output | Unsupported prompt fields fail validation | Provider mapping, validation, durable options, and host controls |
| Historical message/part mutations | Only queued message deletion is implemented | Atomic durable edits/deletes and event projection |
| LSP and formatters | No Pi product adapter | Environment services and SDK discovery/status consumers |
| Multiple named environments | One lazy environment per session | Target selection, permissions, lifecycle, and billing |
| Runtime administration | Kortix controls restart, shares, and project lifecycle | Complete inventory of raw OpenCode calls and equivalent Kortix adapters |

First-party host checks remain separate. SDK transport is shared, but web,
white-label, CLI, and mobile require their own user-input/output verification.
White-label fixed agent/model controls and real incremental streaming passed
against the preview API. The saved reply, empty turn queue, and absent environment
match the browser. These controls do not implement live reconfiguration.

The full preview suite currently fails four Git shipping flows at Platinum
ingress. All 19 browser journeys pass. Large-context automatic compaction is
also blocked by that upload failure. See the verification log for exact probes.

## Benchmarks

The [direct environment comparison](../spikes/pi-worker/bench/DIRECT_ENVIRONMENT.md)
contains 60 passing samples. Both engines use one Daytona environment, the same
model, and the same gateway. The worker was stopped during direct runs and
restored afterward.

- Median process readiness: Pi 104 ms; OpenCode 1,352 ms.
- Warm short/tool completion medians differ by less than 1%.
- This does not establish a general warm-response speedup or a product p95.

The full product lifecycle comparison remains incomplete. Measure worker Pi,
direct Pi, and OpenCode separately. Hold provider, region, account, model,
prompt, and resources constant. Record exact source/config SHAs, p50/p95,
failed samples, cold start, resume, first text, and first environment tool result.
Keep the split worker topology enabled after each direct experiment.

## Acceptance before production

1. Implement the remaining user-facing capabilities or record explicit accepted divergences.
2. Keep focused compiler, worker, daemon, API, SDK, and host tests green.
3. Run real preview sessions for each new capability, including failure and recovery.
4. Run `pnpm test -- --full` locally and `pnpm test -- --target-full` on the exact preview SHA.
5. Verify the same-provider benchmark and restore normal worker operation.
6. Document the test path and all unverified inputs/outputs.
7. Merge to `main` only after explicit user approval. Verify the merged artifact on dev afterward.

Detailed observations and commands are in
[PI_WORKER_VERIFICATION.md](./PI_WORKER_VERIFICATION.md) and
[PI_RUNTIME_UI_VERIFICATION.md](./PI_RUNTIME_UI_VERIFICATION.md).
