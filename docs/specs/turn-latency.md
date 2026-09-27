# Turn latency: the send path is a fingerprint compare, not a rebuild

This is the contract for everything between a user pressing Enter and the model
producing its first token. It exists because that gap is currently **2.5–7.0
seconds** on a warm box with nothing wrong with it — larger than the answer it
precedes.

## 1. The measured baseline (dev, 2026-09-27)

Three identical trivial prompts (`Reply with exactly: OK`) through the endpoint
the UI uses, one warm box, same session:

| | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| send → model starts | **4.90 s** | **2.54 s** | **7.03 s** |
| model generation | 4.21 s | 3.31 s | 3.08 s |
| completion → HTTP return | 0.46 s | 0.97 s | 0.44 s |
| total | 9.57 s | 6.82 s | 10.56 s |

Where the pre-model time goes, from the box's own log aligned to each send:

```
14:42:03.2   prompt sent
14:42:06.465 [env] project env applied                          +3.3 s
14:42:09.542 [runtime-assets] kortix CLI updated from the API   +6.3 s
14:42:11.114 [boot] injected managed kortix skills
```

Supporting measurements, `curl` phase timings from one client (subtract ~150 ms
of DNS+TCP+TLS for network):

| Probe | TTFB |
| --- | --- |
| `GET /health` — no auth, no DB | 0.43–0.55 s |
| `GET /me` | 0.36–1.21 s |
| `GET /accounts` | 0.81–3.54 s |
| `GET /projects` | 0.95–2.98 s |
| `GET /projects/:id/sessions/:id/config` | 2.66–3.12 s |
| API → box daemon health | 0.80–1.18 s |

And the database is not the cause: `EXPLAIN ANALYZE` of the project read on the
same dev database reports `Execution Time: 0.100 ms`, `Planning Time: 22.8 ms`.
The seconds are in the request path, not in query execution.

The turn path today takes **ten sequential stages** before the body reaches
OpenCode — `load-sandbox`, `agent-switch`, `config-converge`,
`model-catalog-converge`, `ingress`, `env-sync`, `wire-id-read`, `turn-begin`,
`upstream`, `turn-accept` (the `ptl.mark()` calls in
`apps/api/src/sandbox-proxy/routes/preview.ts`). Each is awaited. Several make
their own database reads or their own round trip to the box.

## 2. The budget

A warm session whose state has not changed, measured API-side:

| Stage | Budget |
| --- | --- |
| Pre-flight (auth, load, authorize, fingerprint compare) | **≤ 60 ms** |
| API → box delivery hop | ≤ 60 ms |
| **Send → model starts, total** | **≤ 150 ms** |
| A session's FIRST prompt (cold memos) | ≤ 800 ms |
| A prompt that must repair something | bounded, and it says so in the response |

Everything above the budget is a defect with a name, not "the platform is
slow".

## 3. The four rules

### R1 — the send path compares fingerprints, it does not re-derive state

The API holds one **desired** fingerprint per session and the box reports one
**actual** fingerprint (`docs/specs/runtime-convergence.md` defines both). A
turn compares them. Equal ⇒ forward the body, touch nothing else.

No stage on the send path may re-resolve what a fingerprint already answers:
not the manifest, not the secrets snapshot, not the model lineup, not the
asset manifest. A component that cannot be fingerprinted cheaply does not
belong on the send path.

### R2 — pre-flight is parallel; a sequential `await` is a defect unless a data dependency requires it

The unavoidable reads — the sandbox row, the session row, the agent grant, the
provider ingress — have no dependency on each other. They run concurrently and
join once. Writes (the ledger claim, the dedupe claim) happen after the join,
in one place, and never interleave with the reads.

Reviewing this path, the question for every `await` is: *what value does the
next line need from it?* If the answer is "nothing", it is parallel work or it
is off-path work.

### R3 — off-path by default; exactly three things may block a turn

1. **Config release** — the agent's identity changes what the turn IS.
2. **Environment** — but only when its fingerprint actually changed.
3. **Model catalog** — but only when the model THIS turn names is missing from
   the box's map.

Everything else schedules and is never awaited on the send path: binaries
(daemon, CLI, entrypoint, OpenCode), managed-skill overlays, session-title
generation, snapshot sync, runtime projection, audit relays, transcript
mirrors. The asymmetry already written in `runtime-assets/manifest.ts` —
*config blocks the turn, binaries never do* — is hereby the rule for every
non-config component, not a note about one lane.

A scheduled refresh that discovers a real divergence repairs it for the NEXT
turn and records it; it never reaches back and delays the turn that scheduled
it.

### R4 — one round trip per surface, per turn

One call to the box, one read per database row, per turn. A second call to the
same surface is a cache that was not taken. `wire-id-read` making its own box
round trip, and a health probe made once by the config gate and again by the
catalog gate, are the shape this rule forbids.

The same rule applies to the client: a view is **one** composite read, not
thirty. A session view currently issues ~30 requests (`turn`, `prompts`,
`message`, `audit`, `health`, `items`, `change-requests`, repeatedly); at
0.8–3.5 s per authenticated read that is the dominant cost of the UI feeling
slow, independent of any turn.

## 4. What this forbids explicitly

- Awaiting an env round trip on every prompt when nothing changed.
- Installing a binary, an overlay or a skill during a send.
- Generating a session title before the prompt is delivered.
- Re-reading the manifest, the secrets snapshot or the model lineup per turn.
- A pre-flight stage that makes a network call to answer a question a memo
  already answers.
- A client view that issues more than one read to paint.

## 5. Acceptance

A benchmark in the repository, runnable against any deployed target, that
reports the table in §1 and fails when §2's budget is exceeded:

```
pnpm test -- --latency --target <origin>
```

It reports, per run: send → delivered, delivered → model start, model
generation, completion → return, and the pre-flight breakdown by stage. A
change that regresses the warm-session budget fails it. Without this, every
claim in this document is an anecdote — including the ones measured above.
