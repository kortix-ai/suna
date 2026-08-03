'use client';

/**
 * "Is this file actually there?" — for surfaces that turn a path into a
 * clickable affordance.
 *
 * A transcript is a record of what happened, not a description of what exists
 * now. The agent deletes `build_comp_xlsx.py` in step 3 and the message that
 * announced the deletion still renders that path as a live, hover-blue button
 * — click it and the viewer dead-ends on "This file couldn't be opened". The
 * affordance was never earned: it was inferred from the SHAPE of the string
 * (`looksLikeFilePath`), which is a claim about syntax, not about the disk.
 *
 * Three rules keep this cheap:
 *   1. **Verdicts are cached forever, per resolved path.** A path repeated
 *      across a long thread costs one probe for the whole conversation.
 *   2. **In-flight probes are deduped.** Ten spans for the same path share one
 *      request.
 *   3. **Nothing probes on render.** The probe fires on pointer/keyboard
 *      intent (hover, focus) and on click. A message with forty paths in it
 *      issues zero requests until the reader reaches for one.
 *
 * Rule 3 is why the default is optimistic: a path stays clickable until a
 * probe says otherwise, so the common case (the file is there) never flickers
 * from dead to alive. By the time a pointer travels from hover to click the
 * verdict has normally landed; `probeNow` covers the case where it has not.
 */

import { readRuntimeTextFile } from '@kortix/sdk/react';

import { resolveRuntimePath } from './use-oc-file-open';

export type FileAvailability = 'unknown' | 'available' | 'missing';

/**
 * The two I/O calls a probe makes, injectable.
 *
 * Injected rather than mocked because `mock.module` in this workspace is
 * PROCESS-WIDE: swapping `@kortix/sdk/react` for one suite silently replaces
 * it for every sibling suite in the same run, and the first one to import a
 * key the fake omits dies with a `SyntaxError` from a file it never touched.
 * A default parameter costs nothing and cannot leak.
 */
export interface ProbeDeps {
  resolve: (path: string) => Promise<string>;
  read: (path: string) => Promise<unknown>;
}

const defaultDeps: ProbeDeps = {
  resolve: resolveRuntimePath,
  read: readRuntimeTextFile,
};

const verdicts = new Map<string, Exclude<FileAvailability, 'unknown'>>();
const inFlight = new Map<string, Promise<FileAvailability>>();

/** The cached verdict, or `unknown`. Synchronous — safe during render. */
export function peekFileAvailability(path: string): FileAvailability {
  return verdicts.get(path) ?? 'unknown';
}

/** Test seam. Clearing between cases keeps verdicts from leaking across tests. */
export function resetFileAvailability(): void {
  verdicts.clear();
  inFlight.clear();
}

/**
 * Resolve the path the way the panel will, then ask the runtime for it.
 *
 * A read is the only authoritative existence check the runtime exposes, and it
 * is what `discoverPrefixViaFileApi` already uses. It is affordable here only
 * because of rule 3 above — this never runs for a path nobody reached for.
 *
 * A throw is treated as `missing`, which is the honest reading at this layer:
 * whether the cause is a deleted file, a bad prefix, or a dead sandbox, the
 * one thing we know for certain is that opening it would fail. Callers that
 * have no runtime to ask must not call this at all (see `hasRuntimeTarget`) —
 * otherwise every path in a session-less view would be condemned by a network
 * error rather than by its own absence.
 */
export function probeFileAvailability(
  path: string,
  deps: ProbeDeps = defaultDeps,
): Promise<FileAvailability> {
  const cached = verdicts.get(path);
  if (cached) return Promise.resolve(cached);

  const pending = inFlight.get(path);
  if (pending) return pending;

  const probe = (async (): Promise<FileAvailability> => {
    let verdict: Exclude<FileAvailability, 'unknown'>;
    try {
      await deps.read(await deps.resolve(path));
      verdict = 'available';
    } catch {
      verdict = 'missing';
    }
    verdicts.set(path, verdict);
    inFlight.delete(path);
    return verdict;
  })();

  inFlight.set(path, probe);
  return probe;
}
