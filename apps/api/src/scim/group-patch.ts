export class InvalidGroupMemberError extends Error {}

export type GroupChange =
  | { path: 'displayName'; op: 'replace'; value: string }
  | { path: 'externalId'; op: 'replace'; value: string | null }
  | { path: 'members'; op: 'add' | 'replace' | 'remove'; value: string[] | null };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function memberValues(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(m => !m || typeof m.value !== 'string' || !uuid.test(m.value))) {
    throw new Error('members must be an array of valid user references');
  }
  return [...new Set(value.map(m => m.value as string))];
}

export function groupChanges(body: Record<string, unknown>, patch = false): GroupChange[] {
  const changes: GroupChange[] = [];
  const add = (op: string, path: string, value: unknown) => {
    const attr = path.toLowerCase();
    if (attr === 'displayname' && (op === 'add' || op === 'replace')) {
      if (typeof value !== 'string' || !value.trim() || value.trim().length > 128) {
        throw new Error('displayName must contain 1 to 128 characters');
      }
      changes.push({ op: 'replace', path: 'displayName', value: value.trim() });
    } else if (attr === 'externalid') {
      if (op === 'remove') value = null;
      if (value !== null && typeof value !== 'string') throw new Error('externalId must be a string or null');
      changes.push({ op: 'replace', path: 'externalId', value: value as string | null });
    } else if (attr === 'members') {
      changes.push({ op: op as 'add' | 'replace' | 'remove', path: 'members', value: op === 'remove' && value === undefined ? null : memberValues(value) });
    } else {
      const filtered = path.match(/^members\[value\s+eq\s+"([^"]+)"\]$/i);
      if (op !== 'remove' || !filtered) throw new Error(`Unsupported group attribute: ${path}`);
      changes.push({ op: 'remove', path: 'members', value: memberValues([{ value: filtered[1] }]) });
    }
  };
  if (patch) {
    if (!Array.isArray(body.Operations) || body.Operations.length === 0) throw new Error('Operations must be a nonempty array');
    for (const operation of body.Operations) {
      if (!operation || typeof operation !== 'object') throw new Error('Invalid PATCH operation');
      const op = typeof operation.op === 'string' ? operation.op.toLowerCase() : '';
      if (!['add', 'replace', 'remove'].includes(op)) throw new Error('Unsupported PATCH operation');
      if (typeof operation.path === 'string' && operation.path) add(op, operation.path, operation.value);
      else if (operation.path === undefined && op !== 'remove' && operation.value && typeof operation.value === 'object' && !Array.isArray(operation.value)) {
        for (const [path, value] of Object.entries(operation.value)) add(op, path, value);
      } else throw new Error('A pathless PATCH operation requires an attribute object');
    }
  } else {
    for (const [path, value] of Object.entries(body)) {
      if (['schemas', 'id', 'meta'].includes(path.toLowerCase())) continue;
      add('replace', path, value);
    }
  }
  return changes;
}
