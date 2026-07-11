/**
 * Template install builder — pure. Given a resolved `registry:template` (its
 * payload files + capabilities from `buildInstall`), the user's input values,
 * and the target project's current manifest + connectors, produce (a) the exact
 * files to commit (payloads with `{{input}}` rendered + a merged `kortix.yaml`)
 * and (b) the requirement set the install wizard resolves. No git, no db, no
 * clock — the caller does the IO and commits.
 */

import {
  manifestFormatForPath,
  parseManifestText,
  serializeManifestObject,
} from '@kortix/manifest-schema';
import type { RegistryItem, TemplateInput } from '@kortix/registry';

import type { ItemCapabilities } from '../../marketplace/catalog';

/** A connector the template contributes to `kortix.yaml`. Extra keys (Pipedream
 *  app, config, …) pass through to the manifest entry verbatim. */
export interface TemplateConnector {
  slug: string;
  provider: string;
  [key: string]: unknown;
}

/** A trigger the template contributes. String fields may carry `{{input}}`. */
export interface TemplateTrigger {
  slug: string;
  name: string;
  type: 'cron' | 'webhook';
  agent?: string;
  cron?: string;
  timezone?: string;
  secret_env?: string;
  prompt: string;
}

export interface TemplateAgentGrant {
  connectors?: string[];
  secrets?: string[];
  skills?: string[] | 'all';
  kortix_cli?: string[];
}

/** The manifest contribution a template declares (its `meta.template` block). */
export interface TemplateManifestBlock {
  agents?: Record<string, TemplateAgentGrant>;
  connectors?: TemplateConnector[];
  /** Channel platforms (slack/telegram/email) the automation posts to. Connected
   *  via Settings → Channels, NOT a manifest connector — surfaced as an optional
   *  requirement the user can resolve later. */
  channels?: string[];
  triggers?: TemplateTrigger[];
  envOptional?: string[];
}

export type RequirementKind = 'connector' | 'secret' | 'input' | 'channel';
export type RequirementStatus = 'new' | 'reused' | 'pending' | 'resolved';

export interface TemplateRequirement {
  kind: RequirementKind;
  /** connector slug · secret env key · input key. */
  key: string;
  label: string;
  status: RequirementStatus;
  required: boolean;
  provider?: string;
  input?: TemplateInput;
}

export interface BuildTemplateInstallInput {
  template: RegistryItem;
  block: TemplateManifestBlock;
  registryFiles: Array<{ path: string; content: string }>;
  capabilities: ItemCapabilities;
  inputs: Record<string, string>;
  /** Non-input render values available to `{{…}}` (e.g. `projectName`). */
  context?: Record<string, string>;
  manifestRaw: string | null;
  manifestPath: string;
  existingConnectors: Array<{ slug: string; provider: string }>;
  existingSecretKeys: string[];
}

export interface BuildTemplateInstallResult {
  files: Array<{ path: string; content: string }>;
  requirements: TemplateRequirement[];
  /** Final (namespaced) slugs of the triggers the template added — to enable on activation. */
  triggerSlugs: string[];
  manifestPath: string;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/** Substitute `{{key}}` from the resolved inputs (unknown keys → empty). */
export function renderInputs(text: string, inputs: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_m, key: string) => inputs[key] ?? '');
}

/** Resolved inputs = user values over declared defaults. */
export function resolveInputValues(
  declared: TemplateInput[] | undefined,
  provided: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const input of declared ?? []) {
    if (input.default != null) out[input.key] = input.default;
  }
  for (const [k, v] of Object.entries(provided)) {
    if (v != null && v !== '') out[k] = v;
  }
  return out;
}

/** Read + shallow-validate the template's `meta.template` manifest block. */
export function parseTemplateBlock(item: RegistryItem): TemplateManifestBlock {
  const raw = (item.meta?.template ?? {}) as Record<string, unknown>;
  return {
    agents: (raw.agents as TemplateManifestBlock['agents']) ?? undefined,
    connectors: Array.isArray(raw.connectors) ? (raw.connectors as TemplateConnector[]) : undefined,
    channels: Array.isArray(raw.channels) ? (raw.channels as string[]) : undefined,
    triggers: Array.isArray(raw.triggers) ? (raw.triggers as TemplateTrigger[]) : undefined,
    envOptional: Array.isArray(raw.env_optional) ? (raw.env_optional as string[]) : undefined,
  };
}

/** A key free of `taken`, suffixed `-2`, `-3`, … on collision. */
function uniqueKey(desired: string, taken: Set<string>): string {
  if (!taken.has(desired)) return desired;
  for (let n = 2; ; n++) {
    const candidate = `${desired}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function buildTemplateInstall(
  input: BuildTemplateInstallInput,
): BuildTemplateInstallResult {
  const inputs = resolveInputValues(input.template.inputs, input.inputs);
  const renderMap = { ...(input.context ?? {}), ...inputs };
  const format = manifestFormatForPath(input.manifestPath);

  // Payload files with inputs rendered (registry-lock.json is opaque JSON — skip).
  const files = input.registryFiles.map((f) =>
    f.path.endsWith('registry-lock.json')
      ? f
      : { path: f.path, content: renderInputs(f.content, renderMap) },
  );

  const manifest: Record<string, unknown> = input.manifestRaw
    ? structuredClone(parseManifestText(input.manifestRaw, format))
    : { kortix_version: 2, project: { name: input.template.title ?? input.template.name } };

  const requirements: TemplateRequirement[] = [];

  // ── connectors — reuse an existing slug+provider match, else add ───────────
  const connectorList = asArray(manifest.connectors);
  const connectorSlugs = new Set(connectorList.map((c) => String(c.slug)));
  const slugRemap = new Map<string, string>();
  for (const conn of input.block.connectors ?? []) {
    const reused = input.existingConnectors.find(
      (e) => e.slug === conn.slug && e.provider === conn.provider,
    );
    if (reused) {
      slugRemap.set(conn.slug, conn.slug);
      requirements.push({
        kind: 'connector',
        key: conn.slug,
        label: conn.slug,
        provider: conn.provider,
        status: 'reused',
        required: true,
      });
      continue;
    }
    const slug = uniqueKey(conn.slug, connectorSlugs);
    connectorSlugs.add(slug);
    slugRemap.set(conn.slug, slug);
    connectorList.push({ ...conn, slug });
    requirements.push({
      kind: 'connector',
      key: slug,
      label: slug,
      provider: conn.provider,
      status: 'new',
      required: true,
    });
  }
  if (connectorList.length > 0) manifest.connectors = connectorList;

  // ── channels — connected via Settings → Channels, never a manifest connector ─
  for (const channel of input.block.channels ?? []) {
    requirements.push({
      kind: 'channel',
      key: channel,
      label: channel.charAt(0).toUpperCase() + channel.slice(1),
      status: 'pending',
      required: false,
    });
  }

  // ── agents — always namespaced; connector grants follow the slug remap ─────
  const agents = asObject(manifest.agents);
  const agentNames = new Set(Object.keys(agents));
  const agentRemap = new Map<string, string>();
  for (const [name, grant] of Object.entries(input.block.agents ?? {})) {
    const finalName = uniqueKey(name, agentNames);
    agentNames.add(finalName);
    agentRemap.set(name, finalName);
    agents[finalName] = {
      ...grant,
      ...(grant.connectors
        ? { connectors: grant.connectors.map((s) => slugRemap.get(s) ?? s) }
        : {}),
    };
  }
  if (Object.keys(agents).length > 0) manifest.agents = agents;

  // ── triggers — rendered, namespaced, shipped disabled ──────────────────────
  const triggerList = asArray(manifest.triggers);
  const triggerSlugs = new Set(triggerList.map((t) => String(t.slug)));
  const addedTriggers: string[] = [];
  for (const trigger of input.block.triggers ?? []) {
    const slug = uniqueKey(trigger.slug, triggerSlugs);
    triggerSlugs.add(slug);
    addedTriggers.push(slug);
    const entry: Record<string, unknown> = {
      slug,
      name: trigger.name,
      type: trigger.type,
      enabled: false,
      prompt: renderInputs(trigger.prompt, renderMap),
    };
    const agent = trigger.agent ? (agentRemap.get(trigger.agent) ?? trigger.agent) : undefined;
    if (agent) entry.agent = agent;
    if (trigger.cron) entry.cron = renderInputs(trigger.cron, renderMap);
    if (trigger.timezone) entry.timezone = trigger.timezone;
    if (trigger.secret_env) entry.secret_env = trigger.secret_env;
    triggerList.push(entry);
  }
  if (triggerList.length > 0) manifest.triggers = triggerList;

  // ── env.optional — union the template's declared secret keys ───────────────
  const env = asObject(manifest.env);
  const optional = new Set([
    ...(Array.isArray(env.optional) ? (env.optional as string[]) : []),
    ...input.capabilities.secrets,
    ...(input.block.envOptional ?? []),
  ]);
  if (optional.size > 0) {
    env.optional = [...optional];
    if (!Array.isArray(env.required)) env.required = [];
    manifest.env = env;
  }

  files.push({ path: input.manifestPath, content: serializeManifestObject(manifest, format) });

  // ── secret requirements — reuse if the env key is already set ──────────────
  for (const key of input.capabilities.secrets) {
    requirements.push({
      kind: 'secret',
      key,
      label: key,
      status: input.existingSecretKeys.includes(key) ? 'reused' : 'pending',
      required: true,
    });
  }

  // ── input requirements — collected in the Configure step ───────────────────
  for (const declared of input.template.inputs ?? []) {
    requirements.push({
      kind: 'input',
      key: declared.key,
      label: declared.label,
      status: inputs[declared.key] != null ? 'resolved' : 'pending',
      required: declared.required ?? true,
      input: declared,
    });
  }

  return { files, requirements, triggerSlugs: addedTriggers, manifestPath: input.manifestPath };
}
