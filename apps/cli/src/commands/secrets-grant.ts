/**
 * `kortix secrets grant IDENTIFIER --agent <name>` — widen one agent's
 * `secrets:` list with one identifier. Own module: granting is its own
 * audience surface (it can flip the project from "every agent gets
 * everything" to "only listed agents get anything"), kept beside its
 * black-box test.
 */

import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, status } from '../style.ts';
import { IDENTIFIER_RE } from './secrets-delivery.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

/**
 * Grant one secret to one agent.
 *
 * `enforced` and `none` exposures reach a session ONLY when some agent's
 * `secrets:` list names the identifier — `secrets: all` withholds both — so a
 * stored, valid secret can be delivered nowhere at all. That is the
 * `undeliverable` marker `ls` prints, and this is the one command that clears
 * it. It only widens the named agent's list; it never replaces it.
 */
export async function secretsGrant(argv: string[], opts: CtxOpts, json = false): Promise<number> {

  let agent: string | undefined;
  try {
    agent = takeFlagValue(argv, ['--agent']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const identifier = argv.filter((a) => !a.startsWith('-'))[0];
  if (!identifier) {
    process.stderr.write(`${status.err('Pass a secret identifier.')}\n`);
    return 2;
  }
  if (!agent) {
    process.stderr.write(
      `${status.err('Pass --agent <name>.')} ${C.dim}See ${C.reset}${C.cyan}kortix agents ls${C.reset}${C.dim}.${C.reset}\n`,
    );
    return 2;
  }
  if (!IDENTIFIER_RE.test(identifier)) {
    process.stderr.write(`${status.err(`"${identifier}" is not a valid secret identifier.`)}\n`);
    return 2;
  }

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: {
    identifier: string;
    agent: string;
    already_granted: boolean;
    adopted_governance: boolean;
  };
  try {
    resp = await ctx.client.post<typeof resp>(
      `/projects/${ctx.projectId}/secrets/${encodeURIComponent(identifier)}/grant`,
      { agent },
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }
  process.stdout.write(
    resp.already_granted
      ? `${status.info(`${C.bold}${resp.agent}${C.reset} already receives ${C.bold}${resp.identifier}${C.reset}`)}\n`
      : `${status.ok(`${C.bold}${resp.agent}${C.reset} now receives ${C.bold}${resp.identifier}${C.reset}`)}\n`,
  );
  // This edit can flip the project from "every agent gets everything" to "only
  // listed agents get anything". Nothing else says so, and the blast radius is
  // every other agent on the project.
  if (resp.adopted_governance) {
    process.stdout.write(
      `${status.warn('This wrote the first `agents:` block — an agent that is not listed now receives NO project secrets.')}\n`,
    );
  }
  return 0;
}
