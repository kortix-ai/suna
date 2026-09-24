/**
 * create-session — `POST /projects/:id/sessions` with a client-minted
 * `session_id` (COR-185, web parity with
 * `apps/web/src/hooks/projects/use-new-project-session.ts`).
 *
 * The client owns the id, so an ambiguous failure (a client timeout or a
 * server deadline) can be resolved by reading that id back: a row means the
 * create committed and holds the first prompt. Answering "failed" then would
 * let the user send again — two sessions, two answers. Any other failure (a
 * 402 refusal, a validation error) rethrows at once, without a read.
 *
 * Framework-free and injectable, so it is unit-tested with plain fakes.
 */
import { confirmCommitted, errorCode, isAmbiguousCreateFailure } from '@kortix/shared';
import type { CreateProjectSessionInput } from '@/lib/projects/projects-client';

export interface CreateSessionDeps {
  create: (input: CreateProjectSessionInput & { session_id: string }) => Promise<unknown>;
  /** Reads the session row; resolves falsy (or throws) when it does not exist. */
  read: (id: string) => Promise<unknown>;
  /** Test hook for `confirmCommitted`'s wait between reads. */
  sleep?: (ms: number) => Promise<void>;
}

/** Resolves the created session id (always `input.session_id`), or rethrows the create's error. */
export async function createSessionCommitted(
  deps: CreateSessionDeps,
  input: CreateProjectSessionInput & { session_id: string },
): Promise<string> {
  const id = input.session_id;
  try {
    await deps.create(input);
    return id;
  } catch (error) {
    if (
      isAmbiguousCreateFailure(errorCode(error)) &&
      (await confirmCommitted(
        async () => Boolean(await deps.read(id)),
        deps.sleep ? { sleep: deps.sleep } : {},
      ))
    ) {
      return id;
    }
    throw error;
  }
}
