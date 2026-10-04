export interface DatabaseErrorDetails {
  isDatabaseError: true;
  outerName: string;
  outerMessage: string;
  causeName: string | null;
  causeMessage: string | null;
  pgCode: string | null;
  severity: string | null;
  table: string | null;
  schema: string | null;
  detail: string | null;
  hint: string | null;
}

interface ErrorRecord {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  severity?: unknown;
  table?: unknown;
  schema?: unknown;
  schema_name?: unknown;
  detail?: unknown;
  hint?: unknown;
  cause?: unknown;
}

const TRANSIENT_DATABASE_CODES = new Set([
  '40001',
  '40P01',
  '53300',
  '57P01',
  '57P02',
  '57P03',
  'ECONNRESET',
  'ETIMEDOUT',
  'EMAXCONNSESSION',
]);

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function errorChain(error: unknown): ErrorRecord[] {
  const chain: ErrorRecord[] = [];
  const seen = new Set<unknown>();
  let current = error;

  while (current && typeof current === 'object' && !seen.has(current) && chain.length < 8) {
    seen.add(current);
    const record = current as ErrorRecord;
    chain.push(record);
    current = record.cause;
  }

  return chain;
}

function isPostgresCode(code: string | null): boolean {
  return code !== null && (/^[0-9A-Z]{5}$/.test(code) || code === 'EMAXCONNSESSION');
}

export function inspectDatabaseError(error: unknown): DatabaseErrorDetails | null {
  const chain = errorChain(error);
  if (chain.length === 0) return null;

  const postgresNode = chain.find((node) => {
    const name = stringField(node.name);
    const code = stringField(node.code);
    return (
      name === 'PostgresError'
      || stringField(node.severity) !== null
      || isPostgresCode(code)
    );
  });
  const databaseNode =
    postgresNode
    ?? chain.find((node) => stringField(node.name) === 'DrizzleQueryError');
  if (!databaseNode) return null;

  const outer = chain[0];
  const cause = databaseNode === outer ? null : databaseNode;
  return {
    isDatabaseError: true,
    outerName: stringField(outer.name) ?? 'Error',
    outerMessage: stringField(outer.message) ?? String(error),
    causeName: cause ? stringField(cause.name) : null,
    causeMessage: cause ? stringField(cause.message) : null,
    pgCode: stringField(databaseNode.code),
    severity: stringField(databaseNode.severity),
    table: stringField(databaseNode.table),
    schema: stringField(databaseNode.schema_name) ?? stringField(databaseNode.schema),
    detail: stringField(databaseNode.detail),
    hint: stringField(databaseNode.hint),
  };
}

export function isTransientDatabaseError(error: unknown): boolean {
  const chain = errorChain(error);
  for (const node of chain) {
    const code = stringField(node.code);
    if (code?.startsWith('08') || (code && TRANSIENT_DATABASE_CODES.has(code))) {
      return true;
    }
  }

  const text = chain
    .flatMap((node) => [stringField(node.name), stringField(node.message)])
    .filter((value): value is string => value !== null)
    .join(' ')
    .toLowerCase();
  return (
    text.includes('max clients reached')
    || text.includes('connection terminated unexpectedly')
    || text.includes('connection reset')
    || text.includes('socket closed')
  );
}

export async function retryTransientDatabaseRead<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isTransientDatabaseError(error)) throw error;
    return operation();
  }
}
