/**
 * A stored value this server cannot decrypt: `API_KEY_SECRET` changed after
 * the value was written, or the row is damaged (KRTX-1719). Thrown in place of
 * the bare AES-GCM error, so the message names what a person must enter again.
 *
 * Its own module so the connector gateway can recognize it without importing
 * the project-secret envelope.
 */
export class SecretUndecryptableError extends Error {
  constructor(
    readonly label: string,
    /** What a person does about it: one sentence, appended to the message. */
    remedy = 'Re-enter its value.',
  ) {
    super(`${label} cannot be decrypted with this server's encryption key. ${remedy}`);
    this.name = 'SecretUndecryptableError';
  }
}
