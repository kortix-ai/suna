/** PostgreSQL SQLSTATE 23505, including errors wrapped by Drizzle and postgres.js. */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The constraint a PostgreSQL 23505 names (postgres.js `constraint_name`), through Drizzle wrapping; null for any other error. */
export function uniqueViolationConstraint(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const e = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (e.code === '23505') return typeof e.constraint_name === 'string' ? e.constraint_name : null;
    current = e.cause;
  }
  return null;
}
