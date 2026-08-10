import type { SessionScope, SessionScopeInput } from "@kortix/sdk";

import {
  emitJson,
  locateSessionAnywhere,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  takeFlagValues,
} from "../command-helpers.ts";
import { kortixFromAuth } from "../api/sdk.ts";
import { C, help, status } from "../style.ts";

const HELP = help`Usage: kortix sessions scope <session-id> [options]

Read or replace a session's secret and connector access. Changes apply to the
next prompt. Omitted categories remain unchanged. Repeated values form the full
replacement for that category.

Options:
  --secret <identifier>          Replace the secret allowlist (repeatable).
  --no-secrets                   Allow no workspace secrets.
  --inherit-secrets              Remove session narrowing; use the agent grant.
  --connector <alias>=<connection-id>  Replace connector bindings (repeatable).
  --no-connectors                Replace explicit connector bindings with none.
  --require-connector <alias>    Replace required connector aliases (repeatable).
  --no-required-connectors       Require no connector aliases.
  --json                         Print the authoritative scope as JSON.
  --workspace <id>               Operate on this workspace id.
  --host <name>                  Operate on this logged-in host.
  -h, --help                     Show this help.
`;

interface ScopeCommand {
  sessionId: string;
  workspace?: string;
  host?: string;
  json: boolean;
  input: SessionScopeInput;
  update: boolean;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function parseBindings(
  values: string[],
): Record<string, { connection_id: string }> {
  const bindings: Record<string, { connection_id: string }> = {};
  for (const pair of values) {
    const separator = pair.indexOf("=");
    if (separator <= 0 || separator === pair.length - 1) {
      throw new Error(
        `--connector expects alias=connection_id, got "${pair}"`,
      );
    }
    bindings[pair.slice(0, separator)] = {
      connection_id: pair.slice(separator + 1),
    };
  }
  return bindings;
}

function parseScopeCommand(argv: string[]): ScopeCommand | "help" {
  const rest = [...argv];
  if (takeFlagBool(rest, ["-h", "--help"])) return "help";

  const workspace = takeFlagValue(rest, ["--workspace", "--project"]);
  const host = takeFlagValue(rest, ["--host"]);
  const json = takeFlagBool(rest, ["--json"]);
  const secrets = takeFlagValues(rest, ["--secret"]);
  const noSecrets = takeFlagBool(rest, ["--no-secrets"]);
  const inheritSecrets = takeFlagBool(rest, ["--inherit-secrets"]);
  const connectorPairs = takeFlagValues(rest, ["--connector"]);
  const noConnectors = takeFlagBool(rest, ["--no-connectors"]);
  const requiredConnectors = takeFlagValues(rest, ["--require-connector"]);
  const noRequiredConnectors = takeFlagBool(rest, ["--no-required-connectors"]);

  const secretModes =
    Number(secrets.length > 0) + Number(noSecrets) + Number(inheritSecrets);
  if (secretModes > 1) {
    throw new Error(
      "Choose one secrets mode: --secret, --no-secrets, or --inherit-secrets.",
    );
  }
  if (connectorPairs.length > 0 && noConnectors) {
    throw new Error("Choose either --connector or --no-connectors.");
  }
  if (requiredConnectors.length > 0 && noRequiredConnectors) {
    throw new Error(
      "Choose either --require-connector or --no-required-connectors.",
    );
  }

  const sessionId = rest.shift();
  if (!sessionId) throw new Error("Pass a session id.");
  if (rest.length > 0) throw new Error(`Unknown option "${rest[0]}".`);

  const input: SessionScopeInput = {};
  if (secrets.length > 0) input.secrets = unique(secrets);
  else if (noSecrets) input.secrets = [];
  else if (inheritSecrets) input.secrets = null;
  if (connectorPairs.length > 0)
    input.connector_bindings = parseBindings(connectorPairs);
  else if (noConnectors) input.connector_bindings = {};
  if (requiredConnectors.length > 0)
    input.require_connectors = unique(requiredConnectors);
  else if (noRequiredConnectors) input.require_connectors = [];

  return {
    sessionId,
    workspace,
    host,
    json,
    input,
    update: Object.keys(input).length > 0,
  };
}

function secretScopeLabel(values: string[] | null): string {
  if (values === null) return "Agent grant";
  if (values.length === 0) return "None";
  return values.join(", ");
}

function listScopeLabel(values: string[] | null): string {
  if (!values || values.length === 0) return "None";
  return values.join(", ");
}

function canonicalScope(scope: SessionScope): SessionScope {
  return {
    ...scope,
    connector_bindings: Object.fromEntries(
      Object.entries(scope.connector_bindings).map(([alias, binding]) => [
        alias,
        { connection_id: binding.connection_id },
      ]),
    ),
  };
}

function printScope(
  scope: SessionScope,
  sessionId: string,
  updated: boolean,
): void {
  const bindings = Object.entries(scope.connector_bindings);
  process.stdout.write("\n");
  process.stdout.write(
    `  ${C.bold}Session access${C.reset} ${C.dim}${sessionId}${C.reset}\n`,
  );
  process.stdout.write(
    `  ${C.dim}secrets    ${C.reset}${secretScopeLabel(scope.secrets_allowlist)}\n`,
  );
  process.stdout.write(
    `  ${C.dim}required   ${C.reset}${listScopeLabel(scope.required_connectors)}\n`,
  );
  process.stdout.write(
    `  ${C.dim}connectors ${C.reset}${bindings.length === 0 ? "None" : ""}\n`,
  );
  for (const [alias, binding] of bindings) {
    process.stdout.write(
      `               ${alias} ${C.dim}→ ${binding.connection_id}${C.reset}\n`,
    );
  }
  process.stdout.write("\n");
  process.stdout.write(
    `${updated ? status.ok(scope.detail) : status.info(scope.detail)}\n`,
  );
  if (!scope.retroactive) {
    process.stdout.write(
      `${status.warn("Secret values already read cannot be removed from existing context.")}\n`,
    );
  }
  process.stdout.write("\n");
}

export async function runSessionsScope(argv: string[]): Promise<number> {
  let command: ScopeCommand | "help";
  try {
    command = parseScopeCommand(argv);
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n`);
    return 2;
  }
  if (command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  const located = await locateSessionAnywhere(
    command.sessionId,
    { workspaceArg: command.workspace, hostArg: command.host },
    (host) => `kortix sessions scope ${command.sessionId} --host ${host}`,
  );
  if (!located) return 1;
  const { auth, workspaceId, session: sessionRow } = located.located;
  const session = kortixFromAuth(auth).session(workspaceId, sessionRow.session_id);

  let scope: SessionScope;
  try {
    scope = command.update
      ? await session.rescope(command.input)
      : await session.scope();
  } catch (error) {
    return surfaceApiError(error);
  }

  if (command.json) emitJson(canonicalScope(scope));
  else printScope(scope, sessionRow.session_id, command.update);
  return 0;
}
