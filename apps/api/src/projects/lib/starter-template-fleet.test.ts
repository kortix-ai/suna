/**
 * Template-fleet validity tests (Task WS1-P3-b). Two halves:
 *
 *  1. Every shipped `kortix.yaml` in `packages/starter/templates/` (the base
 *     floor + every `marketplace-projects/*` clonable project) is
 *     `kortix_version: 3` and passes `validateManifest` with zero errors.
 *  2. The base template's seeded native config directory for each of the
 *     four ACP harnesses (`.claude`, `.codex`, `.kortix/opencode`, `.pi`)
 *     passes `validateHarnessConfig` with zero issues, and its declared
 *     `runtimes.<name>.config_dir` matches the canonical
 *     `HARNESSES[<name>].configDir`.
 *
 * Also proves the web-studio v2→v3 migration (done by hand in the template
 * file, since the migration function only operates on a live `kortix.yaml`
 * string, not a template on disk) is semantically equivalent to what
 * `migrateManifestV2ToV3` itself would have produced from the original v2
 * source — the original v2 body is preserved verbatim below as a fixture so
 * this equivalence has a fixed, git-independent baseline.
 *
 * PLACEMENT DECISION: colocated in apps/api, not `packages/starter`. Both
 * validators this suite drives — `validateManifest` (`@kortix/manifest-schema`)
 * and `validateHarnessConfig` (`./harness-config-validate`, apps/api-only,
 * pulls in `@kortix/shared` + `./agent-markdown`) — are already apps/api
 * dependencies; `packages/starter`'s `package.json` carries neither as a
 * devDep, and it has no test fixtures for cross-package validation today.
 * apps/api already reads the starter's templates through `@kortix/starter`
 * for real (`./seed-files.ts`, `./starter.ts`), so this file reuses that
 * exact consumption path instead of introducing a second one.
 */
import { describe, expect, test } from 'bun:test';
import { getStarterFiles, getProjectTemplateFiles, type StarterFile } from '@kortix/starter';
import { HARNESS_IDS, HARNESSES } from '@kortix/shared';
import { validateManifest } from '@kortix/manifest-schema';
import { migrateManifestV2ToV3 } from './agent-config-v2';
import { parseManifestString } from '../triggers';
import { type FileTreeEntry, validateHarnessConfig } from './harness-config-validate';

function fileContent(files: StarterFile[], path: string): string {
  const match = files.find((f) => f.path === path);
  if (!match) throw new Error(`template is missing expected file: ${path}`);
  return match.content;
}

// `template: 'minimal'` yields just the `base` layer (see `@kortix/starter`'s
// `getStarterFiles` — `general-knowledge-worker` is only layered in when that
// template id is explicitly requested), which is exactly the floor every
// project — including `general-knowledge-worker` and every marketplace
// project — starts from.
const BASE_FILES = getStarterFiles({ projectName: 'Test Project', template: 'minimal' });
// Slug-prefixed (e.g. `web-studio/kortix.yaml`) — every `marketplace-projects/*`
// clone in one flat array, raw/uninterpolated.
const PROJECT_FILES = getProjectTemplateFiles();

describe('starter template fleet — manifest v3', () => {
  test('base template kortix.yaml is kortix_version 3 and passes validateManifest with zero errors', () => {
    const content = fileContent(BASE_FILES, 'kortix.yaml');
    const result = validateManifest(content, 'yaml');
    expect(result.parsed?.kortix_version).toBe(3);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  test('every marketplace-projects clone kortix.yaml is kortix_version 3 and passes validateManifest with zero errors', () => {
    const manifestPaths = [...new Set(PROJECT_FILES.map((f) => f.path))].filter((p) =>
      /(^|\/)kortix\.yaml$/.test(p),
    );
    // Sweep guard: fails loudly if a future marketplace project is added
    // without a manifest, or if the fixture path pattern stops matching.
    expect(manifestPaths.length).toBeGreaterThan(0);

    for (const path of manifestPaths) {
      const content = fileContent(PROJECT_FILES, path);
      const result = validateManifest(content, 'yaml');
      expect({ path, version: result.parsed?.kortix_version }).toEqual({ path, version: 3 });
      expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    }
  });
});

describe('starter template fleet — seeded native config dirs (base)', () => {
  for (const harness of HARNESS_IDS) {
    test(`${harness}: base template's ${HARNESSES[harness].configDir} seed is non-empty and passes validateHarnessConfig with zero issues`, () => {
      const configDir = HARNESSES[harness].configDir;
      const files: FileTreeEntry[] = BASE_FILES.filter(
        (f) => f.path === configDir || f.path.startsWith(`${configDir}/`),
      ).map((f) => ({ path: f.path, content: f.content }));

      expect(files.length).toBeGreaterThan(0);
      expect(validateHarnessConfig(harness, configDir, files)).toEqual([]);
    });
  }

  test("base kortix.yaml's runtimes.<name>.config_dir matches HARNESSES[<name>].configDir for every harness", () => {
    const content = fileContent(BASE_FILES, 'kortix.yaml');
    const result = validateManifest(content, 'yaml');
    const runtimes = result.parsed?.runtimes as Record<string, { harness: string; config_dir?: string }>;

    for (const harness of HARNESS_IDS) {
      expect(runtimes[harness]).toBeTruthy();
      expect(runtimes[harness].config_dir).toBe(HARNESSES[harness].configDir);
    }
  });
});

// The exact v2 web-studio manifest this task migrated by hand, frozen here as
// a fixed baseline (independent of git history) for the equivalence check
// below.
const WEB_STUDIO_V2 = `
# yaml-language-server: $schema=https://kortix.com/schema/kortix.v2.schema.json
kortix_version: 2

default_agent: studio

project:
  name: "{{projectName}}"
  description: An email-first web studio that designs, deploys, and maintains client websites and bills for them through Stripe.

# The studio needs a few things connected before it can run for real. Add the
# values in the Kortix Secrets Manager / connect the providers in Customize.
env:
  required: []
  optional:
    # A public base to serve preview sites from (Vercel token is a connector).
    - STUDIO_FROM_EMAIL # the address clients email + the agent replies from
    - STUDIO_PRICE_FLOOR # lowest monthly price the studio will quote (e.g. 20)
    - STUDIO_PRICE_CEILING # highest monthly price (e.g. 200)
    - STUDIO_DOMAIN_BUDGET # max USD the studio may spend on a domain w/o asking

opencode:
  config_dir: .kortix/opencode

# GOVERNANCE ONLY (behaviour lives in .kortix/opencode/agents/studio.md).
# The studio is granted broad access so a fresh clone works end-to-end; narrow
# it once you know exactly which connectors/secrets you use.
agents:
  studio:
    connectors: all # email/channel, Stripe, Vercel/deploy, a registrar
    secrets: all
    kortix_cli: all
    skills: all

# ─── Triggers ──────────────────────────────────────────────────────────────
# The studio runs on two triggers. Both are disabled by default so a fresh
# clone never acts before you've connected email + Stripe and reviewed the
# persona. Flip \`enabled: true\` once you're set up.
triggers:
  # 1. Inbound email — the studio's front door. Every client message (a new
  #    request, a change, a question, a reply) fires a session. Wire your
  #    inbound address to this webhook, or connect an email channel in the
  #    dashboard and point it at the \`studio\` agent.
  - slug: inbound-email
    name: Inbound email
    type: webhook
    agent: studio
    enabled: false
    secret_env: WEBHOOK_EMAIL_SECRET # HMAC secret; add via Secrets Manager
    prompt: |
      A client email arrived. Handle it end-to-end per your studio workflow.

      From: {{ body.from }}
      Subject: {{ body.subject }}

      {{ body.text }}

  # 2. Heartbeat — keeps the studio's own house in order between emails:
  #    follow up ONCE on unpaid previews, confirm live sites are still up,
  #    reconcile the client ledger, and surface anything that needs you.
  - slug: heartbeat
    name: Studio heartbeat
    type: cron
    agent: studio
    enabled: false
    cron: "0 0 */4 * * *" # every 4 hours
    timezone: UTC
    prompt: |
      Run your heartbeat: read the client ledger in \`.kortix/memory/\`, send at
      most one gentle reminder per unpaid preview (respect opt-outs), verify
      each live site still resolves, redeploy anything that drifted, and open a
      short \`studio: …\` note if something needs a human. Do nothing that spends
      money or emails a NEW (un-contacted) prospect without asking first.
`;

describe('starter template fleet — web-studio v2→v3 migration equivalence', () => {
  test('the hand-migrated web-studio kortix.yaml is semantically equal to migrateManifestV2ToV3 output from the original v2 source', () => {
    const originalParsed = parseManifestString(WEB_STUDIO_V2, 'yaml', 'kortix.yaml');
    expect(originalParsed.schemaVersion).toBe(2);

    const applied = migrateManifestV2ToV3(originalParsed);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const handMigratedContent = fileContent(PROJECT_FILES, 'web-studio/kortix.yaml');
    const handParsed = parseManifestString(handMigratedContent, 'yaml', 'kortix.yaml');
    expect(handParsed.schemaVersion).toBe(3);

    // Deep-equal, not key-order-sensitive: `migrateManifestV2ToV3` builds its
    // output object via spread (original key order, `runtimes` appended
    // last), while the on-disk file is hand-written in the base template's
    // canonical v3 field order for readability. Both are the same document.
    expect(handParsed.raw).toEqual(applied.raw);
  });
});
