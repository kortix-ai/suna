export class RuntimeIdentityConflictError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} already has an authoritative runtime identity`);
    this.name = 'RuntimeIdentityConflictError';
  }
}
