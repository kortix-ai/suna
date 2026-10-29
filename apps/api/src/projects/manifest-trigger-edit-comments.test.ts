import { isDeepStrictEqual } from 'node:util';
import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { manifestWrites, parseManifestString, serializeManifest } from './manifest-io';
import { removeTriggerFromManifest, upsertTriggerInManifest } from './lib/trigger-manifest';
import { draftToSpec, parseTriggerDraft, specToBody } from './lib/trigger-draft';
import { extractTriggers } from './trigger-entry';

/**
 * The manifest-write path for trigger edits (PATCH/POST/DELETE /triggers and
 * the web trigger editor all funnel through upsertTriggerInManifest /
 * removeTriggerFromManifest + manifestWrites) must be comment-preserving: a
 * one-field edit may only change that trigger's lines, never reserialize the
 * file (KRTX-2742). The fixture mirrors the real shape: rationale comments at
 * the top, per-trigger comments, a folded prompt scalar, and an aligned
 * inline comment.
 */
const FIXTURE = `# Kortix manifest — edited by both humans and the agent.
# The comments below carry the reasons behind each grant; keep them.
kortix_version: 3

project:
  name: probe

default_agent: kortix

agents:
  kortix:
    # Full access — this is the operator agent (grant rationale, do not drop).
    connectors: all
    secrets: all

# Nightly automation.
triggers:
  # Runs the deploy audit at night; see the incident notes from September.
  - slug: nightly-audit
    name: Nightly audit
    type: cron
    agent: kortix
    enabled: true
    cron: "0 3 * * *"
    timezone: UTC
    prompt: >-
      Run the deploy audit and post a summary. Check every service
      and name the error in the run line.
  # Support triage loop.
  - slug: support-triage
    name: Support triage
    type: monitor
    agent: kortix
    enabled: true
    run: support-sweep
    interval: 5m # polls; the stream monitor carries no interval
`;

const commentLines = (text: string): string[] =>
  text.split('\n').filter((line) => line.trimStart().startsWith('#'));

/** The exact manifest mutation the PATCH /triggers/:slug route runs
 *  (routes/triggers.ts): merge the patch onto the current spec's body, parse
 *  the draft, upsert, then take the write through manifestWrites. */
function patchTrigger(manifestText: string, slug: string, patch: Record<string, unknown>): string {
  const manifest = parseManifestString(manifestText, 'yaml', 'kortix.yaml');
  const current = extractTriggers(manifest).specs.find((s) => s.slug === slug);
  if (!current) throw new Error(`fixture has no trigger ${slug}`);
  const draft = parseTriggerDraft({ ...specToBody(current), ...patch, slug }, { existingSlug: slug });
  if ('error' in draft) throw new Error(draft.error);
  const next = upsertTriggerInManifest(manifest, draftToSpec(draft, manifest.path));
  manifest.raw = next.raw;
  const writes = manifestWrites(manifest, manifest.path);
  expect(writes.files).toHaveLength(1);
  expect(writes.files[0]?.path).toBe('kortix.yaml');
  return writes.files[0]?.content ?? '';
}

/** The DELETE /triggers/:slug route's mutation. */
function removeTrigger(manifestText: string, slug: string): string {
  const manifest = parseManifestString(manifestText, 'yaml', 'kortix.yaml');
  const next = removeTriggerFromManifest(manifest, slug);
  manifest.raw = next.raw;
  return manifestWrites(manifest, manifest.path).files[0]?.content ?? '';
}

/** The POST /triggers route's mutation. */
function addTrigger(manifestText: string, body: Record<string, unknown>): string {
  const manifest = parseManifestString(manifestText, 'yaml', 'kortix.yaml');
  const draft = parseTriggerDraft({ ...body, slug: body.slug }, { existingSlug: null });
  if ('error' in draft) throw new Error(draft.error);
  const next = upsertTriggerInManifest(manifest, draftToSpec(draft, manifest.path));
  manifest.raw = next.raw;
  return manifestWrites(manifest, manifest.path).files[0]?.content ?? '';
}

describe('trigger edits keep every YAML comment (KRTX-2742)', () => {
  test('disabling one trigger changes only that trigger and drops no comment', () => {
    const after = patchTrigger(FIXTURE, 'nightly-audit', { enabled: false });

    // Every comment line survives byte-identical, in order.
    const afterLines = after.split('\n');
    expect(commentLines(after)).toEqual(commentLines(FIXTURE));

    // Only the edited trigger's lines changed: everything before its entry
    // and everything from the next trigger on is byte-identical.
    const before = FIXTURE.split('\n');
    const entryStart = before.indexOf('  - slug: nightly-audit');
    const entryEnd = before.indexOf('  # Support triage loop.');
    expect(entryStart).toBeGreaterThan(0);
    expect(entryEnd).toBeGreaterThan(entryStart);
    expect(afterLines.slice(0, entryStart)).toEqual(before.slice(0, entryStart));
    expect(afterLines.slice(afterLines.length - (before.length - entryEnd))).toEqual(
      before.slice(entryEnd),
    );

    // The edit itself landed.
    expect(after).toContain('enabled: false');
    const data = parseYaml(after) as { triggers: Array<{ slug: string; enabled: boolean }> };
    expect(data.triggers.find((t) => t.slug === 'nightly-audit')?.enabled).toBe(false);
    expect(data.triggers.find((t) => t.slug === 'support-triage')?.enabled).toBe(true);
  });

  test('the same edit applied twice is stable (the second write is a no-op)', () => {
    const once = patchTrigger(FIXTURE, 'nightly-audit', { enabled: false });
    const twice = patchTrigger(once, 'nightly-audit', { enabled: false });
    expect(twice).toBe(once);
  });

  test('removing a trigger takes its own comment and leaves the rest byte-identical', () => {
    const after = removeTrigger(FIXTURE, 'support-triage');

    expect(commentLines(after)).toEqual(commentLines(FIXTURE).filter((line) => !line.includes('Support triage loop')));
    expect(after).not.toContain('support-triage');
    expect(after).toContain('  - slug: nightly-audit');
    // The removed entry's lines are gone; its neighbors are untouched.
    expect(after).toContain('    cron: "0 3 * * *"');
    const data = parseYaml(after) as { triggers: Array<{ slug: string }> };
    expect(data.triggers.map((t) => t.slug)).toEqual(['nightly-audit']);
  });

  test('adding a trigger appends it to the list and keeps every comment', () => {
    const after = addTrigger(FIXTURE, {
      name: 'Release notes',
      type: 'webhook',
      prompt_template: 'Summarize {{ body.text }}',
      secret_env: 'RELEASE_WEBHOOK_SECRET',
    });

    expect(commentLines(after)).toEqual(commentLines(FIXTURE));
    const data = parseYaml(after) as { triggers: Array<Record<string, unknown> & { slug: string }> };
    expect(data.triggers.map((t) => t.slug)).toEqual(['nightly-audit', 'support-triage', 'release-notes']);
    // A new trigger is written in the on/run shape; enabled (the default) stays out of the file.
    expect(data.triggers[2]).toEqual({
      slug: 'release-notes', name: 'Release notes',
      on: { webhook: { secret: 'RELEASE_WEBHOOK_SECRET' } }, run: { prompt: 'Summarize {{ body.text }}' },
    });
    // Existing entries stay byte-identical: the new entry lands after them.
    const afterLines = after.split('\n');
    expect(afterLines.indexOf('  - slug: nightly-audit')).toBe(
      FIXTURE.split('\n').indexOf('  - slug: nightly-audit'),
    );
  });

  test('adding the first trigger to a manifest whose triggers list is empty keeps comments', () => {
    const empty = FIXTURE.replace(
      /triggers:\n[\s\S]*?interval: 5m # polls; the stream monitor carries no interval\n/,
      'triggers: []\n',
    );
    expect(empty).toContain('triggers: []');

    const after = addTrigger(empty, {
      name: 'Release notes',
      type: 'webhook',
      prompt_template: 'Summarize {{ body.text }}',
      secret_env: 'RELEASE_WEBHOOK_SECRET',
    });

    expect(commentLines(after)).toEqual(commentLines(empty));
    const data = parseYaml(after) as { triggers: Array<{ slug: string }> };
    expect(data.triggers.map((t) => t.slug)).toEqual(['release-notes']);
  });

  test('adding the first trigger to a manifest with no triggers key keeps comments', () => {
    // The scaffold case POST /triggers exists for: a real commented manifest
    // that has never had a trigger. The write must append the list, not fall
    // back to a full re-serialize (which strips every comment) — comment
    // preservation must not depend on the word "triggers" appearing anywhere
    // in the source.
    const withoutTriggers = FIXTURE.slice(0, FIXTURE.indexOf('# Nightly automation.')).trimEnd() + '\n';
    expect(withoutTriggers).not.toContain('triggers');

    const after = addTrigger(withoutTriggers, {
      name: 'Release notes',
      type: 'webhook',
      prompt_template: 'Summarize {{ body.text }}',
      secret_env: 'RELEASE_WEBHOOK_SECRET',
    });

    expect(commentLines(after)).toEqual(commentLines(withoutTriggers));
    const data = parseYaml(after) as { triggers: Array<{ slug: string }> };
    expect(data.triggers.map((t) => t.slug)).toEqual(['release-notes']);
  });

  test('the committed text carries exactly the data a full re-serialize would', () => {
    const after = patchTrigger(FIXTURE, 'nightly-audit', { enabled: false });
    const manifest = parseManifestString(FIXTURE, 'yaml', 'kortix.yaml');
    const data = parseYaml(after) as Record<string, unknown>;
    const expectedRaw = parseYaml(FIXTURE) as {
      triggers: Array<Record<string, unknown>>;
    };
    expectedRaw.triggers[0]!.enabled = false;
    expect(isDeepStrictEqual(data, expectedRaw)).toBe(true);
    // And the result still validates as the same manifest version.
    expect(data.kortix_version).toBe(3);
  });

  test('a non-trigger change to raw still lands (the doc path must never drop it)', () => {
    const manifest = parseManifestString(FIXTURE, 'yaml', 'kortix.yaml');
    manifest.raw.agents = { kortix: { connectors: 'none', secrets: 'none' } };
    const content = manifestWrites(manifest, manifest.path).files[0]?.content ?? '';
    const data = parseYaml(content) as { agents: { kortix: { connectors: string } } };
    expect(data.agents.kortix.connectors).toBe('none');
  });

  test('a TOML manifest still round-trips through the same path', () => {
    const toml = `kortix_version = 3

[[triggers]]
slug = "nightly-audit"
name = "Nightly audit"
type = "cron"
agent = "kortix"
enabled = true
cron = "0 3 * * *"
prompt = "Run the audit"
`;
    const manifest = parseManifestString(toml, 'toml', 'kortix.toml');
    const current = extractTriggers(manifest).specs[0]!;
    const draft = parseTriggerDraft({ ...specToBody(current), enabled: false }, { existingSlug: 'nightly-audit' });
    if ('error' in draft) throw new Error(draft.error);
    const next = upsertTriggerInManifest(manifest, draftToSpec(draft, manifest.path));
    manifest.raw = next.raw;
    const writes = manifestWrites(manifest, manifest.path);
    expect(writes.files[0]?.path).toBe('kortix.toml');
    const text = writes.files[0]?.content ?? '';
    expect(text).toContain('enabled = false');
    expect(serializeManifest(parseManifestString(text, 'toml', 'kortix.toml'))).toContain(
      'enabled = false',
    );
  });
});
