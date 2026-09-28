import {
  AGENT_BROWSER_VERSION,
  ANYDOC_VERSION,
  BUN_SHA256_AMD64,
  BUN_SHA256_ARM64,
  BUN_VERSION,
  NODE_VERSION,
  NPM_VERSION,
  OPENCODE_VERSION,
  PI_SYSTEM_PACKAGES,
  PNPM_SHA256_AMD64,
  PNPM_SHA256_ARM64,
  PNPM_VERSION,
  PYTHON_VERSION,
  UV_SHA256_AMD64,
  UV_SHA256_ARM64,
  UV_VERSION,
} from '@kortix/shared';
import { SANDBOX_VERSION, config } from '../config';
import { snapshotEmbedsAgentForBootMode } from './compiled-runtime-fingerprint';
import {
  buildRuntimeArtifactFingerprint,
  cliConnectorRuntimeArtifacts,
} from './runtime-fingerprint';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const AGENT_SRC_DIR = resolve(REPO_ROOT, 'apps/kortix-sandbox-agent-server/src');
const AGENT_PKG_JSON = resolve(REPO_ROOT, 'apps/kortix-sandbox-agent-server/package.json');
const ENTRYPOINT_PATH = process.env.KORTIX_SNAPSHOT_ENTRYPOINT_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/entrypoint.sh');
const OPENCODE_WARMUP_PATH = process.env.KORTIX_SNAPSHOT_OPENCODE_WARMUP_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/opencode-warmup.sh');
const MACHINE_DOC_PATH = process.env.KORTIX_SNAPSHOT_MACHINE_DOC_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/MACHINE.md');
const SLACK_CLI_SRC_PATH = process.env.KORTIX_SNAPSHOT_SLACK_CLI_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/slack-cli');
// Source of the `kortix` CLI binary baked into every sandbox. We fingerprint
// the SOURCE (not the compiled binary, which `bun build --compile` produces
// non-deterministically) so a CLI code change rebuilds snapshots while a
// rebuild of the identical source does not.
//
// Scope: only the files whose change can alter what the CLI does INSIDE a
// sandbox. The single compiled `kortix` binary bakes ALL of apps/cli/src, but a
// session only ever invokes `kortix connectors` / `kortix connectors mcp` — the rest
// (`ship`, `cr`, `tunnel`, `self-host`, `accounts`, the whole `init`/scaffold
// surface, …) is developer-facing and runs on a laptop, never in the sandbox.
// Hashing the WHOLE tree meant every dev-only CLI edit re-minted every project's
// runtime identity AND moved the non-agent `swapKey`, which DISABLES the cheap
// agent-swap fast path and forces a full O(all-projects) rebuild (measured: ~4 of
// 11 forced mass-rebuilds over 2 weeks were pure dev-CLI churn). So we hash the
// in-sandbox connector import-closure instead of `apps/cli/src` wholesale.
//
// This closure is asserted complete by snapshots/__tests__/cli-connector-closure
// .test.ts, which re-derives it from the `kortix connectors` entrypoints and fails
// if a new import escapes the hashed set — so scoping can never silently ship a
// stale in-sandbox connector. packages/manifest-schema is only reached by
// laptop-side `ship`/`validate` and is deliberately not fingerprinted.
const CLI_ROOT = resolve(REPO_ROOT, 'apps/cli');
// The standard image bakes the canonical starter repository at
// /opt/kortix/scaffold.git. A starter change must invalidate the non-agent
// fingerprint. Otherwise the agent-swap path can copy a new agent onto an old
// image while preserving a stale scaffold, which makes every fresh session
// reject its local Git bundle and fall back to the network clone.
const STARTER_ROOT = resolve(REPO_ROOT, 'packages/starter');
const FINGERPRINT_EXCLUDES = ['node_modules', '.bin', 'dist', '.turbo', '.cache'] as const;

// Bump when the rendered Kortix Dockerfile layer changes (the Dockerfile text
// itself is not hashed into the snapshot fingerprint, so a layer change needs a
// manual version bump to invalidate cached images). v2: bake OpenCode config
// deps into /opt/kortix/opencode-config-deps for offline boot-time install.
// v10: warm a real opencode project instance at build time (instance-warm) so the
// one-time first-instance plugin/model/ripgrep cost is cached into the image
// instead of paid on the session hot path (6–60s → ~2–4s cold start).
// v11: bake a real Chromium (Playwright, cross-arch) for agent-browser so the
// browser-automation skill works out of the box with no runtime download.
// v12: bake the full LLM model catalog (/opt/kortix/llm-catalog.json) so the
// no-restart warm seed serves the full picker without a PARK-time fetch.
// v14: bake the COMPLETE config-dir deps (incl. @opencode-ai/plugin + its effect/
// zod/sdk tree + overrides) instead of a partial hardcoded list.
// v15: pin the baked @opencode-ai/plugin to the OPENCODE BINARY version (opencode
// loads the plugin SDK matching its own binary and re-fetches it over the network
// if the baked tree carries a different version — the stale starter pin left every
// boot re-installing it, the ~5–8s opencode-session-created gap).
// v16: ship the `meet` channel CLI + the kortix-meet skill.
// v17: `meet chat` (bot talks back in-call) + live-relay skill section.
// v18: `meet speak` (TTS voice in-call) + voice-reply skill section.
// v19: natural-conversation relay (debounce + acknowledgement + follow-up) skill notes.
// v20: multi-platform rebrand (Meet/Zoom/Teams) + dedicated speaking skill section.
// v21: configurable bot name (project setting) + wake word = bot's first name (skill).
// v22: spoken turns MUST reply by voice (skill) — no chat fallback for speech.
// v23: auto-recap on meeting end (bot.done webhook -> session produces notes).
// v24: hard-fail the bake if the baked opencode-config-deps tree (or the
// starter tool files against it) can't actually be bundled by Bun — a
// bundle-breaking axios override once shipped silently baked into every
// sandbox image (bun install succeeded; the runtime bundle did not).
// v25: bake the `kortix skills` subcommand into the in-sandbox CLI so the
// seeded kortix-system <live-skills> pointer (`kortix skills get <name>`)
// resolves — without this rebake, fresh sandboxes run an older baked CLI that
// hard-errors on `kortix skills`.
// v26: layer robustness. (a) The starter Python floor moved OUT of the system
// interpreter into a `--system-site-packages` venv at /opt/kortix/pyfloor (on the
// front of PATH): the old `pip install --break-system-packages` fought dpkg for
// any floor package the USER's Dockerfile had apt-installed — a project's
// `gdal-bin` pulled dpkg-owned python3-numpy 1.26.4, our `numpy>=1.26` resolved
// to 2.x, pip tried to uninstall it and hard-failed the build ("RECORD file not
// found ... installed by debian") on a CORRECT user image. pip in a venv cannot
// uninstall a dpkg package at all, which retires the whole class (every floor
// member has a dpkg counterpart). (b) The post-warm-up `find /workspace
// -mindepth 1 -delete` is now emitted ONLY for the shared default image; custom
// templates get a targeted cleanup of just the staged starter config, so an
// image that seeds /workspace (a documented WORKDIR) no longer has it silently
// deleted. (c) ENV DEBIAN_FRONTEND=noninteractive is set by the layer instead of
// being inherited by luck from the user's base.
// v27: Chromium layer cache-determinism + download hardening. (a) Moved the
// agent-browser/Playwright Chromium RUN to sit BEFORE the per-project warm-repo
// clone (and the opencode instance warm-up that follows it), instead of after.
// The repo-clone step bakes a FRESH short-lived git credential into its RUN
// text on every single invocation (~1h GitHub App installation token, or a JWT
// with a live iat/exp), so it can never build-cache-hit — and neither can
// anything chained after it. With Chromium previously downstream of that clone
// step, EVERY per-project warm bake re-downloaded the ~150MB Chrome-for-Testing
// from cdn.playwright.dev, live-observed timing out staging's ke2e suite
// ("Downloading Chrome for Testing ... timed out after 30000ms"). Chromium now
// sits immediately after the toolchain floor — a prefix that is byte-identical
// across the shared default image AND every per-project warm bake — so its
// build-cache key is identical everywhere and one cache-populating build (e.g.
// the shared-default rebuild) serves every later warm bake, for every project.
// (b) Regardless of cache state, hardened the Chromium download itself:
// PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=300000 (was Playwright's 30s default)
// + a 5-attempt backoff retry loop around `playwright install --with-deps
// chromium`, so a transient CDN blip no longer fails the whole image build.
// v28: v27's cache-order fix made the Chromium RUN text byte-identical across
// bakes, but under concurrency (3+ simultaneous per-project bakes) the
// opportunistic build-cache STILL did not reliably hit — the provider's
// build-cache is not something we can observe or guarantee from here, so
// per-project warm bakes kept re-downloading Chromium and saturating egress
// (root cause of the v0.10.11 prod rollback). Two changes: (a) per-project warm
// bakes now prefer building FROM the already-built default image
// (buildPerProjectWarmFromBaseDockerfile in dockerfile-layer.ts, wired through
// ensurePerProjectWarmImage) — Chromium is INHERITED, not re-installed, so
// there is no download to miss, no matter what the provider's cache does. This
// requires the default image to already be `active` on the provider; when it
// isn't (or the provider can't report an image ref), the builder falls back to
// the v27 full-rebuild path unchanged. (b) Raised
// PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT to 1800000 (30min, was 300000/5min) as
// a safety net for that fallback path under a cold cache.
// v29: fix the BASE default image rebuild (the gap v27/v28 left open). v27/v28
// only moved Chromium above the per-project warm-repo clone + instance warm-up,
// and made per-project bakes inherit Chromium FROM the base — but in the base
// image's own build (kortixToolchainLayer with no warmRepo) Chromium STILL sat
// BELOW the opencode install, the `opencode serve` migration-bake, and the
// config-deps bun install. The migration-bake writes a sqlite db with live
// timestamps and the config-deps install churns node_modules mtimes — both
// non-deterministic — so on a content-addressed provider cache (Daytona) they
// bust the cache for the Chromium layer chained below them. The kortix-agent
// SOURCE feeds the snapshot fingerprint (AGENT_RUNTIME_ARTIFACTS below), so any
// agent-server code change mints a brand-new base snapshot name → a full rebuild
// on Daytona (no agent-swap) → Chromium re-download → the base image never
// becomes ready inside the session window → "session never starts" (the actual
// mechanism behind the v0.10.11 rollback: PR #5010 changed the agent-server and
// re-minted the base hash). Fix: move the Chromium block to sit DIRECTLY on the
// deterministic apt + pip floors, ABOVE opencode and every non-deterministic
// layer. Chromium's content hash is now stable across agent-source churn — it is
// fetched at most once per pinned Playwright/agent-browser version and
// cache-reused for every base rebuild after.
// v30: run the toolchain and daemon as `kortix`, restore the runtime environment
// when a provider discards image USER/ENV, extract OpenCode cache warming, and
// bake the platform machine guide at /MACHINE.md.
// v31: replace remote installer-script execution with versioned release
// artifacts whose amd64 and arm64 SHA-256 digests live in the runtime manifest.
// Pin Bun and include every artifact digest in the runtime fingerprint.
// v32: accept uv's release target metadata in `uv --version`. uv 0.11.30 emits
// `uv 0.11.30 (x86_64-unknown-linux-gnu)`, so v31's exact comparison failed
// every cold image build. The version bump invalidates any cached v31 image.
// v33: the `meet` CLI becomes `voice` and loses `speak` — the agent no longer
// reads replies aloud one at a time; a realtime model holds the conversation and
// calls back into the session. This bump MUST roll out before the API-side meet
// routes are removed: a sandbox baked at =<v32 still runs `meet speak`, and its
// skill tells it never to fall back to a raw API, so it would report a retired
// feature as a transient provider failure mid-call.
// v37: require a source digest beside the compiled sandbox CLI.
// v39: bake the pinned Python package floor (runtime-versions.json
// `pythonPackages`) into the managed interpreter — starter skills and bare
// `python3` run with zero per-script resolution or runtime PyPI downloads.
// v40: create a private, kortix-owned /var/run/kortix before daemon startup.
// Platinum replaces /run and starts the image as `kortix`, so that directory
// does not survive provider startup.
// v41: store durable daemon state under /home/kortix/.local/state/kortix. This
// path remains writable when a provider replaces /run or discards image USER.
// v43: per-project warm images extract the single Git metadata archive directly
// into /workspace without retaining it. Repo warm-up uses only canonical
// OpenCode config while it indexes /workspace, then restores the exact checkout.
// v44: install the shared shell tool floor (rg, fd, bat, jq, fzf, …) from
// @kortix/shared/sandbox shell-tools.ts, with `fd`/`bat` linked to Debian's names.
// v45: bake /etc/profile.d/zz-kortix.sh + an /etc/bash.bashrc hook
// (kortixShellProfileRun). Debian's /etc/profile resets PATH in the web
// terminal's `bash -l`, so pnpm/uv/bun tools (opencode) were not found on
// Debian-based custom templates; terminals also never loaded project secrets.
const RUNTIME_LAYER_VERSION = 'verified-runtime-artifacts-v48';

// The runtime layer bakes source artifacts into every template's rootfs. Exactly
// TWO are the kortix-agent binary; the rest (entrypoint, in-sandbox CLI surface,
// slack-cli, SDK-backed Connector client) are the non-agent runtime. The
// agent-swap fast path
// replaces ONLY the agent, so the builder must prove the NON-agent runtime is
// byte-identical before swapping — hence the split into two artifact sets.
const AGENT_RUNTIME_ARTIFACTS = [
  { label: 'kortix-agent-src', path: AGENT_SRC_DIR, excludeNames: FINGERPRINT_EXCLUDES },
  { label: 'kortix-agent-pkg', path: AGENT_PKG_JSON },
];
const NON_AGENT_RUNTIME_ARTIFACTS = [
  { label: 'kortix-entrypoint', path: ENTRYPOINT_PATH },
  { label: 'kortix-opencode-warmup', path: OPENCODE_WARMUP_PATH },
  { label: 'kortix-machine-doc', path: MACHINE_DOC_PATH },
  { label: 'kortix-slack-cli', path: SLACK_CLI_SRC_PATH, excludeNames: FINGERPRINT_EXCLUDES },
  { label: 'kortix-starter', path: STARTER_ROOT, excludeNames: FINGERPRINT_EXCLUDES },
  // Only the in-sandbox `kortix connectors` closure (NOT the whole apps/cli/src) —
  // see CLI_CONNECTOR_RUNTIME_FILES in @kortix/shared. This artifact set also
  // includes @kortix/sdk because the compiled CLI owns the Connector client.
  ...cliConnectorRuntimeArtifacts(CLI_ROOT),
];
// Both version strings fold in the layer/opencode/browser/sandbox constants — all
// NON-agent inputs (bumped when the layer/opencode/browser change, not the agent
// binary), so they belong in BOTH fingerprints. The per-process cache re-walks the
// actual files on every fresh deploy, so an agent-src change between deploys moves
// the full fingerprint (drift) while leaving the non-agent fingerprint unchanged.
const runtimeIntegrityKey = () =>
  [
    PNPM_SHA256_AMD64,
    PNPM_SHA256_ARM64,
    UV_SHA256_AMD64,
    UV_SHA256_ARM64,
    BUN_SHA256_AMD64,
    BUN_SHA256_ARM64,
  ].join(':');
const runtimeVersionKey = () =>
  `${SANDBOX_VERSION}:${RUNTIME_LAYER_VERSION}:${PNPM_VERSION}:${NODE_VERSION}:${NPM_VERSION}:${UV_VERSION}:${PYTHON_VERSION}:${BUN_VERSION}:${OPENCODE_VERSION}:${AGENT_BROWSER_VERSION}:${ANYDOC_VERSION}:${PI_SYSTEM_PACKAGES.join(',')}:${runtimeIntegrityKey()}`;
const sandboxVersionStr = () =>
  `${SANDBOX_VERSION}:layer:${RUNTIME_LAYER_VERSION}:pnpm:${PNPM_VERSION}:node:${NODE_VERSION}:npm:${NPM_VERSION}:uv:${UV_VERSION}:python:${PYTHON_VERSION}:bun:${BUN_VERSION}:oc:${OPENCODE_VERSION}:ab:${AGENT_BROWSER_VERSION}:anydoc:${ANYDOC_VERSION}:pi:${PI_SYSTEM_PACKAGES.join(',')}:integrity:${runtimeIntegrityKey()}`;

let runtimeFingerprintCache: { key: string; value: string } | null = null;
let runtimeFingerprintInflight: Promise<string> | null = null;
let nonAgentFingerprintCache: { key: string; value: string } | null = null;
let nonAgentFingerprintInflight: Promise<string> | null = null;

/**
 * Cache the runtime artifact fingerprint by the pinned version constants only,
 * NOT by the source dir mtime. Mtime-keyed caching used to invalidate on every
 * file save in `apps/kortix-sandbox-agent-server/src` (and every git checkout),
 * forcing a ~30 MB tree walk on the session-boot hot path. The version
 * constants are bumped explicitly when the runtime layer actually changes —
 * that's the right invalidation trigger.
 *
 * Concurrent first-callers share the same in-flight promise so a session-boot
 * burst doesn't spawn N parallel tree walks.
 *
 * Exported for the warm-snapshot baker (snapshots/warm-bake.ts), which derives
 * the warm-base name from this fingerprint so a new release (SANDBOX_VERSION
 * bump / runtime source change) automatically gets a fresh warm base.
 */
export async function currentRuntimeArtifactFingerprint(): Promise<string> {
  const key = runtimeVersionKey();
  if (runtimeFingerprintCache?.key === key) return runtimeFingerprintCache.value;
  if (runtimeFingerprintInflight) return runtimeFingerprintInflight;

  runtimeFingerprintInflight = buildRuntimeArtifactFingerprint({
    sandboxVersion: sandboxVersionStr(),
    opencodeVersion: OPENCODE_VERSION,
    artifacts: runtimeArtifactsForBootMode(config.KORTIX_COMPILED_BOOT_MODE),
  })
    .then((value) => {
      runtimeFingerprintCache = { key, value };
      runtimeFingerprintInflight = null;
      return value;
    })
    .catch((err) => {
      runtimeFingerprintInflight = null;
      throw err;
    });
  return runtimeFingerprintInflight;
}

export function runtimeArtifactsForBootMode(
  mode: 'off' | 'shadow' | 'prefer' | 'required',
): Array<(typeof AGENT_RUNTIME_ARTIFACTS)[number] | (typeof NON_AGENT_RUNTIME_ARTIFACTS)[number]> {
  // In prefer/required mode server.mjs carries the daemon. Daemon source is no
  // longer an image input, so changing it must not mint an 8 GB snapshot.
  // Shadow/off still execute the baked daemon and retain the original identity.
  return snapshotEmbedsAgentForBootMode(mode)
    ? [...AGENT_RUNTIME_ARTIFACTS, ...NON_AGENT_RUNTIME_ARTIFACTS]
    : [...NON_AGENT_RUNTIME_ARTIFACTS];
}

/**
 * Fingerprint of the runtime layer EXCLUDING the kortix-agent binary. Changes iff
 * a NON-agent runtime input moved — opencode/entrypoint/CLI/slack-cli/SDK/
 * starter source, or the layer/browser/sandbox version constants. The
 * agent-swap fast path is sound ONLY when this is byte-identical between the
 * predecessor and the new identity (i.e. the agent binary is the SOLE runtime
 * delta). Folded into the template's swapKey so the builder can compare against the
 * predecessor's stored value — see maybeSwapAgent in builder.ts.
 */
export async function currentNonAgentRuntimeFingerprint(): Promise<string> {
  const key = runtimeVersionKey();
  if (nonAgentFingerprintCache?.key === key) return nonAgentFingerprintCache.value;
  if (nonAgentFingerprintInflight) return nonAgentFingerprintInflight;

  nonAgentFingerprintInflight = buildRuntimeArtifactFingerprint({
    sandboxVersion: sandboxVersionStr(),
    opencodeVersion: OPENCODE_VERSION,
    artifacts: [...NON_AGENT_RUNTIME_ARTIFACTS],
  })
    .then((value) => {
      nonAgentFingerprintCache = { key, value };
      nonAgentFingerprintInflight = null;
      return value;
    })
    .catch((err) => {
      nonAgentFingerprintInflight = null;
      throw err;
    });
  return nonAgentFingerprintInflight;
}
