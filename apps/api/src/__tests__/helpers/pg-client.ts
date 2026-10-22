import postgres from 'postgres';

const jsonText = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

/**
 * One dedicated PostgreSQL session with the small `client.query(text, values)
 * → { rows, rowCount }` surface the DB suites use, on the declared `postgres`
 * driver. `max: 1` pins every statement to one connection, so `SET`,
 * `BEGIN`/`COMMIT` and `pg_backend_pid()` mean what they say. A string bound
 * to a json/jsonb parameter is sent as JSON text, as `pg` did: the suites pass
 * `JSON.stringify(...)` there, and the driver default would store a JSON string.
 */
export class PgClient {
  private readonly sql: postgres.Sql;

  constructor(options: { connectionString?: string }) {
    this.sql = postgres(options.connectionString ?? '', {
      max: 1,
      onnotice: () => {},
      types: {
        json: { to: 114, from: [114], serialize: jsonText, parse: JSON.parse },
        jsonb: { to: 3802, from: [3802], serialize: jsonText, parse: JSON.parse },
      },
    });
  }

  async connect(): Promise<void> {
    await this.sql`select 1`;
  }

  async query<T = any>(text: string, values: readonly unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    const params = values.map((value) => (value === undefined ? null : value)) as postgres.ParameterOrJSON<never>[];
    const result = await this.sql.unsafe(text, params);
    return { rows: result as unknown as T[], rowCount: result.count };
  }

  async end(): Promise<void> {
    await this.sql.end();
  }
}
