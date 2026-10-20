import type { ProjectSecret } from './projects-client';

/** `usable_by_me` is a legacy field older servers send (see SecretsNavPage). */
type ListedSecret = ProjectSecret & { usable_by_me?: boolean };

/**
 * The value this member's sessions read cannot be decrypted (KRTX-1719): their
 * active override, else the shared value. It is stored, so it is not "Not set",
 * and it never arrives, so it is not "Using …" either.
 */
export function secretUndecryptable(s: ListedSecret | null): boolean {
  if (s?.effective_source === 'mine') return s.mine?.status === 'undecryptable';
  if (s?.effective_source === 'shared') return s.status === 'undecryptable';
  return false;
}

/** The state line of one secrets row. */
export function secretStatusText(s: ListedSecret | null): string {
  if (!s) return 'Not set';
  if (s.effective_source === 'mine') {
    return secretUndecryptable(s) ? 'Your own value cannot be decrypted' : 'Using your own value';
  }
  if (s.effective_source === 'shared') {
    return secretUndecryptable(s) ? 'Shared value cannot be decrypted' : 'Using the shared value';
  }
  if (s.configured && !s.usable_by_me) return 'Shared exists, not shared with you';
  return 'Not set';
}
