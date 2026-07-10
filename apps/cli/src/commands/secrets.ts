import { readFileSync } from 'node:fs';
import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { loadLocalManifest } from '../manifest.ts';
import { C, help, pad, status } from '../style.ts';
import type {
  ProjectSecret,
  ProjectSecretsResponse,
} from '../api/types.ts';

const HELP = help`Usage: kortix secrets <subcommand> [options]

Manage encrypted env-var secrets on the linked Kortix project. Values
are AES-256-GCM-encrypted at rest and injected into session sandboxes
at boot.

A secret is profile-like: an IDENTIFIER (the unique handle an agent's
\`secrets\` grant references), a KEY (the env var injected into the sandbox),
and a value. Leave the identifier blank and it defaults to the key — the
common case. Set it explicitly to keep a second value under the same key
(e.g. a backup key).

Subcommands:
  ls                                List secrets (by identifier, → key when it
                                    differs) + manifest [env] spec. --json.
  set KEY=VALUE [KEY=VALUE …]       Upsert one or more secrets. Identifier
                                    defaults to KEY.
                                    Use \`KEY=-\` to read VALUE from stdin.
    --identifier <id>               Store under an explicit identifier (a second
    --id <id>                       value under the same KEY). One KEY=VALUE only.
  request NAME [NAME …]             Mint a short-lived link for a human to
                                    ENTER the value(s) — you never see/handle
                                    the raw key. Surface the URL (web: fill-in
                                    modal, Slack: tappable link).
                                    --scope runtime|connector  --expires <min>
  unset IDENTIFIER [IDENTIFIER …]   Remove one or more secrets (by identifier).

Which agents may use a secret is governed by that agent's \`secrets\` grant in
kortix.yaml (by identifier), not a per-secret setting here.

Global options:
  --project <id>     Operate on this project id (default: linked or
                     \$KORTIX_PROJECT_ID).
  -h, --help         Show this help.
`;

export async function runSecrets(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  const json = takeFlagBool(rest, ['--json']);
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  try {
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const ctxOpts = { projectArg: projectFlag, hostArg: hostFlag };

  switch (sub) {
    case 'ls':
    case 'list':
      return secretsLs(ctxOpts, json);
    case 'set':
      return secretsSet(rest, ctxOpts);
    case 'request':
    case 'req':
      return secretsRequest(rest, ctxOpts, json);
    case 'unset':
    case 'rm':
    case 'remove':
      return secretsUnset(rest, ctxOpts);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

type CtxOpts = { projectArg?: string; hostArg?: string };

// Mirrors the backend's isValidIdentifier / web IDENTIFIER_REGEX: alphanumeric
// start, then letters/digits/_.- up to 128 chars total. Validated here only for
// a friendly error — the server is authoritative (incl. the key-conflict 409).
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** A displayed secret slot: keyed by identifier, with the env key it injects. */
type SecretRow = {
  identifier: string;
  key: string;
  spec: 'required' | 'optional' | 'undeclared';
  set: boolean;
};

async function secretsLs(opts: CtxOpts, json = false): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: ProjectSecretsResponse;
  try {
    resp = await ctx.client.get<ProjectSecretsResponse>(
      `/projects/${ctx.projectId}/secrets`,
    );
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
  const required = usingLocal ? local!.env.required : resp.required;
  const optional = usingLocal ? local!.env.optional : resp.optional;

  // The manifest [env] contract is by env KEY (uppercased names the runtime
  // needs); a secret is addressed by IDENTIFIER and injects one KEY. So we match
  // required/optional against the key, but list rows by identifier — surfacing
  // two identifiers under one key as two distinct rows (the web does the same).
  const requiredSet = new Set(required);
  const optionalSet = new Set(optional);
  const setKeys = new Set(resp.items.map((s) => s.name));
  const requiredMissing = required.filter((k) => !setKeys.has(k));

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
      allRows.push({ identifier: key, key, spec, set: false });
    } else {
      for (const s of backing) {
        allRows.push({ identifier: s.identifier, key: s.name, spec, set: true });
      }
    }
  }
  for (const s of resp.items) {
    if (!seenDeclared.has(s.name)) {
      allRows.push({ identifier: s.identifier, key: s.name, spec: 'undeclared', set: true });
    }
  }

  if (json) {
    emitJson({
      secrets: allRows.map((r) => ({
        identifier: r.identifier,
        key: r.key,
        has_value: r.set,
        source: r.spec,
      })),
      manifest: {
        status: usingLocal ? 'local' : resp.manifest_status,
        required,
        optional,
      },
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
  process.stdout.write(
    `  ${C.dim}${pad('IDENTIFIER', nameW)}   STATUS    SPEC${C.reset}\n`,
  );
  for (const r of allRows) {
    const marker = r.set ? `${C.green}● ${C.reset}` : `${C.yellow}○ ${C.reset}`;
    const statusTxt = r.set ? 'set     ' : 'missing ';
    const specColor =
      r.spec === 'required' && !r.set
        ? C.yellow
        : r.spec === 'undeclared'
          ? C.faded
          : C.dim;
    // Show the injected env key only when it differs from the identifier —
    // the second-value-under-same-key case (mirrors the web's "→ key").
    const keyHint = r.key !== r.identifier ? ` ${C.dim}→ ${r.key}${C.reset}` : '';
    process.stdout.write(
      `${marker}${pad(r.identifier, nameW)}   ${statusTxt}  ${specColor}${r.spec}${C.reset}${keyHint}\n`,
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
  process.stdout.write(
    `  ${C.dim}${resp.items.length} set · ${required.length} required · ${optional.length} optional${C.reset}\n\n`,
  );
  return 0;
}

async function secretsSet(args: string[], opts: CtxOpts): Promise<number> {
  // An explicit identifier (--identifier / --id) keeps a second value under the
  // same KEY. It addresses exactly one secret, so it pairs with a single
  // KEY=VALUE; omit it and the identifier defaults to the KEY (the common case,
  // where any number of pairs is fine).
  let identifier: string | undefined;
  try {
    identifier = takeFlagValue(args, ['--identifier', '--id']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  if (identifier !== undefined) {
    identifier = identifier.trim();
    if (!IDENTIFIER_RE.test(identifier)) {
      process.stderr.write(
        `${status.err(
          `invalid identifier "${identifier}" — start alphanumeric, then letters/digits/._- (max 128 chars)`,
        )}\n`,
      );
      return 2;
    }
  }

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  if (args.length === 0) {
    process.stderr.write(`${status.err('Pass at least one KEY=VALUE pair.')}\n`);
    return 2;
  }

  const pairs: { key: string; value: string }[] = [];
  let stdinUsed = false;
  for (const raw of args) {
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      process.stderr.write(`${status.err(`malformed pair "${raw}" — expected KEY=VALUE`)}\n`);
      return 2;
    }
    // The backend uppercases + validates the key; do it here too so the printed
    // identifier/key match what's stored (parity with the web KEY_NAME field).
    const key = raw.slice(0, eq).trim().toUpperCase();
    let value = raw.slice(eq + 1);
    if (value === '-') {
      if (stdinUsed) {
        process.stderr.write(`${status.err('Only one KEY=- per invocation.')}\n`);
        return 2;
      }
      stdinUsed = true;
      value = readFileSync(0, 'utf8').replace(/\n$/, '');
    }
    pairs.push({ key, value });
  }

  if (identifier !== undefined && pairs.length !== 1) {
    process.stderr.write(
      `${status.err('--identifier addresses one secret — pass exactly one KEY=VALUE pair.')}\n`,
    );
    return 2;
  }

  let okCount = 0;
  for (const p of pairs) {
    const shownId = identifier ?? p.key;
    const label =
      shownId !== p.key
        ? `${C.bold}${shownId}${C.reset} ${C.dim}→ ${p.key}${C.reset}`
        : `${C.bold}${p.key}${C.reset}`;
    try {
      await ctx.client.post<ProjectSecret>(`/projects/${ctx.projectId}/secrets`, {
        name: p.key,
        ...(identifier !== undefined ? { identifier } : {}),
        value: p.value,
      });
      okCount += 1;
      process.stdout.write(`${status.ok(label)}\n`);
    } catch (err) {
      surfaceApiError(err);
      process.stderr.write(`  ${C.dim}└─ for ${shownId}${C.reset}\n`);
    }
  }
  process.stdout.write(`\n  ${C.dim}${okCount}/${pairs.length} set${C.reset}\n\n`);
  return okCount === pairs.length ? 0 : 1;
}

async function secretsRequest(rest: string[], opts: CtxOpts, json = false): Promise<number> {
  let scope: string | undefined;
  let expires: string | undefined;
  try {
    scope = takeFlagValue(rest, ['--scope']);
    expires = takeFlagValue(rest, ['--expires']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const names = rest.map((n) => n.trim().toUpperCase()).filter(Boolean);
  if (names.length === 0) {
    process.stderr.write(`${status.err('Pass at least one secret NAME to request.')}\n`);
    return 2;
  }

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: { url: string; names: string[]; scope: string; expires_at: string };
  try {
    resp = await ctx.client.post(`/projects/${ctx.projectId}/secret-requests`, {
      names,
      ...(scope ? { scope } : {}),
      ...(expires ? { expires_in_minutes: Number(expires) } : {}),
    });
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }

  process.stdout.write(
    `\n  ${C.bold}Hand this link to whoever has the value${C.reset} ${C.faded}(${resp.names.join(', ')})${C.reset}\n` +
      `  ${C.cyan}${resp.url}${C.reset}\n\n` +
      `  ${C.dim}Web: opens a fill-in modal. Slack: a tappable link. You never see the value.${C.reset}\n` +
      `  ${C.dim}Expires ${resp.expires_at}.${C.reset}\n\n`,
  );
  return 0;
}

async function secretsUnset(names: string[], opts: CtxOpts): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  if (names.length === 0) {
    process.stderr.write(`${status.err('Pass at least one secret name to unset.')}\n`);
    return 2;
  }

  let okCount = 0;
  for (const name of names) {
    try {
      await ctx.client.delete(`/projects/${ctx.projectId}/secrets/${encodeURIComponent(name)}`);
      okCount += 1;
      process.stdout.write(`${status.ok(`removed ${C.bold}${name}${C.reset}`)}\n`);
    } catch (err) {
      surfaceApiError(err);
      process.stderr.write(`  ${C.dim}└─ for ${name}${C.reset}\n`);
    }
  }
  process.stdout.write(`\n  ${C.dim}${okCount}/${names.length} removed${C.reset}\n\n`);
  return okCount === names.length ? 0 : 1;
}
