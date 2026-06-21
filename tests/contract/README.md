# Contract tests (Pact)

Consumer-driven contract testing with [Pact](https://docs.pact.io/) — the OSS
standard for verifying that a consumer (e.g. the dashboard) and a provider (the
Kortix API) agree on a contract, without spinning up both sides together.

Two halves:

1. **Consumer test** (`health.consumer.pact.test.ts`) — runs the consumer's
   expectations against a Pact **mock provider**, and on success writes a pact
   file to `pacts/`.
2. **Provider verification** (`verify-provider.ts`) — replays that pact file
   against a **real running API** and fails if the provider no longer satisfies
   the contract.

This complements ke2e: ke2e checks the API behaves correctly; Pact checks the
API still honors the exact shape a named consumer depends on.

## Install

```bash
cd tests
npm install --save-dev @pact-foundation/pact@^15.0.1
```

`@pact-foundation/pact` is OSS (MIT) and ships the native Pact FFI core, the
mock server, and the provider `Verifier` — no Ruby, no extra services required.

## 1. Consumer side — generate the pact

```bash
cd tests
bun test contract/health.consumer.pact.test.ts
```

The consumer test never touches a real API. It declares interactions against an
in-process mock server and, on pass, writes
`pacts/kortix-dashboard-kortix-api.json`. Commit that file (or publish it to a
broker — see below). For CI JUnit:

```bash
bun test contract/health.consumer.pact.test.ts \
  --reporter=junit --reporter-outfile=test-results/contract/junit.xml
```

## 2. Provider side — verify against a running API

Start the API, then:

```bash
cd tests

# default provider base: http://localhost:8008 (note: NOT /v1-suffixed —
# the pact paths already include /v1)
bun contract/verify-provider.ts

# against another environment
PROVIDER_BASE_URL=https://dev-api.kortix.com bun contract/verify-provider.ts
```

The verifier reads every `pacts/*.json` file, replays each interaction against
the live provider, and exits non-zero on mismatch. `stateHandlers` maps each
provider-state string (e.g. `"the api is healthy"`) to setup logic — health
needs none, but stateful contracts use this to seed data before replay.

| Variable | Default | Description |
|----------|---------|-------------|
| `PROVIDER_BASE_URL` | `http://localhost:8008` | Running API origin (no `/v1`) |
| `PROVIDER_VERSION` | `dev` | Version label recorded with results |

## Optional: Pact Broker

A [Pact Broker](https://docs.pact.io/pact_broker) (the OSS broker, or hosted
PactFlow) is the recommended way to share pacts between repos and gate deploys
with `can-i-deploy`. Run the OSS broker locally with Docker:

```bash
docker run -d --name pact-broker -p 9292:9292 pactfoundation/pact-broker
```

Publish the consumer pact, then verify from the broker:

```bash
# publish (consumer side)
npx pact-broker publish tests/contract/pacts \
  --broker-base-url http://localhost:9292 \
  --consumer-app-version "$(git rev-parse --short HEAD)"

# verify from broker (provider side) — set the env vars and re-run the script
PACT_BROKER_BASE_URL=http://localhost:9292 \
PACT_PUBLISH_VERIFICATION=true \
PROVIDER_BASE_URL=http://localhost:8008 \
bun contract/verify-provider.ts
```

`verify-provider.ts` auto-switches to broker mode when `PACT_BROKER_BASE_URL` is
set (uses `consumerVersionSelectors: [{ latest: true }]`); otherwise it falls
back to local `pacts/*.json` files.

| Variable | Description |
|----------|-------------|
| `PACT_BROKER_BASE_URL` | Broker URL; switches the verifier to broker mode |
| `PACT_BROKER_TOKEN` | Broker auth token (PactFlow / secured broker) |
| `PACT_PUBLISH_VERIFICATION` | `true` to publish verification results back |

## Files

- `health.consumer.pact.test.ts` — consumer test, writes `pacts/`.
- `verify-provider.ts` — provider verification (local files or broker).
- `pacts/` — generated pact files (gitignored output dir; keep `.gitkeep`).
