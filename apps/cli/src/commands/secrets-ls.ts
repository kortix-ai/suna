import type { ProjectSecret, ProjectSecretsResponse } from '../api/types.ts';
import {
   emitJson, resolveProjectContext, surfaceApiError ,

  type CtxOpts,
} from '../command-helpers.ts';
import { loadLocalManifest } from '../manifest.ts';
import { C, pad, status, visibleWidth } from '../style.ts';


/** A displayed secret slot: keyed by identifier, with the env key it injects. */
type SecretRow = {
  identifier: string;
  key: string;
  spec: 'required' | 'optional' | 'undeclared';
  configured: boolean;
  available: boolean;
  effectiveSource: 'mine' | 'shared' | 'none';
  strategy: 'runtime' | 'egress' | 'broker' | 'denied';
  consumer: ProjectSecret['consumer'];
  deliveryStatus: 'available' | 'unavailable' | 'disabled';
  requiresRotation: boolean;
  /** False for a declared key the calling agent's grant excludes: a value may
   *  be set, but this session never receives it and the API does not list it. */
  granted: boolean;
  /** Audience labels; empty = everyone in the project. */
  sharedWith: string[];
  /** False when the value is shared with specific people and not the caller. */
  usable: boolean;
};

/**
 * The WHO CAN USE cell: `everyone` for a value with no audience grant (or a
 * grant to the project), else the audience labels. `(not you)` marks a value
 * the caller lists only because they manage the project's secrets.
 */
function secretAudienceLabel(row: { sharedWith: string[]; usable: boolean }): string {
  const audience = row.sharedWith.length === 0 ? 'everyone' : row.sharedWith.join(', ');
  return row.usable ? audience : `${audience} (not you)`;
}

/**
 * The DELIVERY cell: the secret's exposure, or the service that spends it.
 *
 * The words are the model's own: `runtime` reads as
 * "environment" because that is the exposure a reader has to weigh, and
 * `egress` reads as its host list because the hosts ARE the policy. A
 * `broker` row has no sandbox presence at all, so it names its spender.
 *
 * `delivery_status` is the field that says an enforced secret is dead — stored,
 * valid and delivered nowhere. `denied` reports 'disabled' as its own target
 * and is a choice rather than a fault, so only 'unavailable' is flagged. The
 * marker is text, not colour, because the CLI runs unstyled under NO_COLOR and
 * in pipes.
 */
export function deliveryCell(row: {
  strategy: SecretRow['strategy'];
  consumer: SecretRow['consumer'];
  deliveryStatus: SecretRow['deliveryStatus'];
  requiresRotation: boolean;
}): string {
  const target =
    row.strategy === 'runtime'
      ? 'environment'
      : row.strategy === 'denied'
        ? 'disabled'
        : row.strategy === 'broker'
          ? (row.consumer ?? 'Kortix service')
          : // Colon, not the ` · ` the markers below use — the exposure and its
            // hosts are one fact, and a second ` · ` would read as a third one.
            'enforced: approved hosts';
  const undeliverable =
    row.deliveryStatus === 'unavailable' ? ` ${C.red}· unavailable${C.reset}` : '';
  const rotation = row.requiresRotation ? ' · rotate' : '';
  return `${target}${undeliverable}${rotation}`;
}

export async function secretsLs(opts: CtxOpts, json = false): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: ProjectSecretsResponse;
  try {
    resp = await ctx.client.get<ProjectSecretsResponse>(`/projects/${ctx.projectId}/secrets`);
  } catch (err) {
    return surfaceApiError(err);
  }

  // The server's required/optional come from its mirror of kortix.yaml, which
  // is eventually-consistent — right after `kortix ship` it can still be empty
  // ("missing"), which would mislabel freshly-declared secrets as "undeclared".
  // The local kortix.yaml is authoritative + instant, so fall back to it
  // whenever the cloud mirror isn't loaded yet.
  const local = (() => {
    try {
      return loadLocalManifest();
    } catch {
      return null;
    }
  })();
  const usingLocal = resp.manifest_status !== 'loaded' && local !== null;
  const localEnv = usingLocal && local ? local.env : null;
  const required = localEnv?.required ?? resp.required;
  const optional = localEnv?.optional ?? resp.optional;

  // The manifest [env] contract is by env KEY (uppercased names the runtime
  // needs); a secret is addressed by IDENTIFIER and injects one KEY. So we match
  // required/optional against the key, but list rows by identifier — surfacing
  // two identifiers under one key as two distinct rows (the web does the same).
  const requiredSet = new Set(required);
  const optionalSet = new Set(optional);
  const itemState = (secret: ProjectSecret) => {
    const configured = secret.configured ?? true;
    const effectiveSource = secret.effective_source ?? (configured ? 'shared' : 'none');
    return {
      configured,
      effectiveSource,
      available: effectiveSource !== 'none',
      strategy: secret.strategy ?? 'runtime',
      consumer: secret.consumer ?? (secret.strategy === 'denied' ? null : 'sandbox'),
      deliveryStatus:
        secret.delivery_status ?? (secret.strategy === 'denied' ? 'disabled' : 'available'),
      requiresRotation: secret.requires_rotation ?? false,
      sharedWith: (secret.shared_with ?? []).some((share) => share.principal_type === 'project')
        ? []
        : (secret.shared_with ?? []).map((share) => share.label),
      usable: secret.usable ?? true,
    };
  };
  // Inside an agent session the API lists only the identifiers that agent is
  // granted. A declared key it omits is then NOT known to be missing — it may be
  // set and simply withheld from this agent. Reporting it as "missing" is what
  // sent humans to re-enter values that were already saved.
  const agentScope = resp.agent_scope ?? null;
  const scopedGrant =
    agentScope && agentScope.secrets !== 'all'
      ? new Set(agentScope.secrets.map((identifier) => identifier.toUpperCase()))
      : null;
  const isGranted = (identifier: string) =>
    !scopedGrant || scopedGrant.has(identifier.toUpperCase());
  const availableKeys = new Set(
    resp.items.filter((secret) => itemState(secret).available).map((secret) => secret.name),
  );
  const requiredMissing = required.filter((key) => !availableKeys.has(key) && isGranted(key));

  const declaredOrder: string[] = [];
  const seenDeclared = new Set<string>();
  for (const k of [...required, ...optional]) {
    if (!seenDeclared.has(k)) {
      seenDeclared.add(k);
      declaredOrder.push(k);
    }
  }

  const allRows: SecretRow[] = [];
  for (const key of declaredOrder) {
    const spec = requiredSet.has(key) ? 'required' : 'optional';
    const backing = resp.items.filter((s) => s.name === key);
    if (backing.length === 0) {
      allRows.push({
        identifier: key,
        key,
        spec,
        configured: false,
        available: false,
        effectiveSource: 'none',
        strategy: 'runtime',
        consumer: 'sandbox',
        deliveryStatus: 'available',
        requiresRotation: false,
        granted: isGranted(key),
        sharedWith: [],
        usable: true,
      });
    } else {
      for (const s of backing) {
        const state = itemState(s);
        allRows.push({ identifier: s.identifier, key: s.name, spec, ...state, granted: true });
      }
    }
  }
  for (const s of resp.items) {
    if (!seenDeclared.has(s.name)) {
      const state = itemState(s);
      allRows.push({
        identifier: s.identifier,
        key: s.name,
        spec: 'undeclared',
        ...state,
        granted: true,
      });
    }
  }

  if (json) {
    emitJson({
      secrets: allRows.map((r) => ({
        identifier: r.identifier,
        name: r.key,
        configured: r.configured,
        available: r.available,
        effective_source: r.effectiveSource,
        strategy: r.strategy,
        consumer: r.consumer,
        delivery_status: r.deliveryStatus,
        requires_rotation: r.requiresRotation,
        granted: r.granted,
        shared_with: r.sharedWith,
        usable: r.usable,
        // Backward-compatible aliases for older CLI JSON consumers.
        key: r.key,
        has_value: r.available,
        source: r.spec,
      })),
      manifest: {
        status: usingLocal ? 'local' : resp.manifest_status,
        required,
        optional,
      },
      agent_scope: agentScope,
    });
    return 0;
  }

  process.stdout.write('\n');
  if (usingLocal) {
    process.stdout.write(
      `  ${C.dim}Manifest: cloud mirror ${resp.manifest_status} — showing local kortix.yaml [env] spec.${C.reset}\n\n`,
    );
  } else if (resp.manifest_status !== 'loaded') {
    process.stdout.write(
      `  ${C.dim}Manifest: ${resp.manifest_status}${
        resp.manifest_error ? ` — ${resp.manifest_error}` : ''
      }${C.reset}\n\n`,
    );
  }

  if (resp.items.length === 0 && required.length === 0 && optional.length === 0) {
    process.stdout.write(`  ${C.dim}No secrets set, no [env] spec in kortix.yaml.${C.reset}\n\n`);
    return 0;
  }

  const nameW = Math.max(...allRows.map((r) => r.identifier.length), 4);
  // The cell carries an undeliverable marker, so its width is not fixed — size
  // the column from the rows the way IDENTIFIER already is.
  const rendered = allRows.map((r) => ({ row: r, delivery: deliveryCell(r) }));
  const deliveryW = Math.max(
    ...rendered.map((entry) => visibleWidth(entry.delivery)),
    'DELIVERY'.length,
  );
  const statusOf = (r: SecretRow) =>
    !r.granted
      ? 'not granted'
      : r.available
        ? r.effectiveSource === 'mine'
          ? 'personal'
          : 'set'
        : 'missing';
  const statusW = Math.max(
    ...allRows.map((r) => statusOf(r).length),
    'STATUS'.length,
    'personal'.length,
  );
  const accessW = Math.max(
    ...allRows.map((r) => secretAudienceLabel(r).length),
    'WHO CAN USE'.length,
  );
  process.stdout.write(
    `  ${C.dim}${pad('IDENTIFIER', nameW)}   ${pad('STATUS', statusW)}  ${pad('DELIVERY', deliveryW)}  ${pad('WHO CAN USE', accessW)}  SPEC${C.reset}\n`,
  );
  for (const { row: r, delivery } of rendered) {
    // A stored value is not a delivered one. Green-for-configured alone let a
    // secret whose delivery path this deployment cannot run print as healthy,
    // so the dot answers "will this arrive?", not just "is a value set?".
    const marker = !r.available
      ? `${C.yellow}○ ${C.reset}`
      : r.deliveryStatus === 'unavailable'
        ? `${C.red}● ${C.reset}`
        : `${C.green}● ${C.reset}`;
    const statusTxt = pad(statusOf(r), statusW);
    const specColor =
      r.spec === 'required' && !r.available ? C.yellow : r.spec === 'undeclared' ? C.faded : C.dim;
    // Show the injected env key only when it differs from the identifier —
    // the second-value-under-same-key case (mirrors the web's "→ key").
    const keyHint = r.key !== r.identifier ? ` ${C.dim}→ ${r.key}${C.reset}` : '';
    process.stdout.write(
      `${marker}${pad(r.identifier, nameW)}   ${statusTxt}  ${pad(delivery, deliveryW)}  ${pad(secretAudienceLabel(r), accessW)}  ${specColor}${r.spec}${C.reset}${keyHint}\n`,
    );
  }

  process.stdout.write('\n');
  if (requiredMissing.length > 0) {
    process.stdout.write(
      `  ${status.warn(
        `${requiredMissing.length} required secret${
          requiredMissing.length === 1 ? '' : 's'
        } missing — sessions will start but may misbehave.`,
      )}\n`,
    );
  }
  const undeliverable = allRows.filter((row) => row.deliveryStatus === 'unavailable');
  if (undeliverable.length > 0) {
    process.stdout.write(
      `  ${status.warn(
        `${undeliverable.length} secret${
          undeliverable.length === 1 ? '' : 's'
        } cannot be delivered — the chosen path is not available on this project.`,
      )}\n`,
    );
  }
  const notGranted = allRows.filter((row) => !row.granted);
  if (agentScope && notGranted.length > 0) {
    const names = notGranted.map((row) => row.key).join(', ');
    process.stdout.write(
      `  ${status.warn(
        `${notGranted.length} secret${notGranted.length === 1 ? ' is' : 's are'} not granted to agent ${agentScope.agent} (${names}) — ` +
          'a value may be set, but this session never receives it.',
      )}\n` +
        `  ${C.dim}Fix (a person with project access; an agent cannot widen its own grant): ` +
        `Customize → Agents → ${agentScope.agent} → Secrets and enable ${notGranted.length === 1 ? 'it' : 'them'}. ` +
        `Then run \`kortix secrets sync\` to pull ${notGranted.length === 1 ? 'it' : 'them'} into this session.${C.reset}\n`,
    );
  }
  if (scopedGrant && agentScope) {
    process.stdout.write(
      `  ${C.dim}Listed: only the secrets agent ${agentScope.agent} is granted. Others are hidden, not missing.${C.reset}\n`,
    );
  }
  const availableCount = allRows.filter((row) => row.available).length;
  process.stdout.write(
    `  ${C.dim}${availableCount} available · ${required.length} required · ${optional.length} optional${C.reset}\n\n`,
  );
  return 0;
}
