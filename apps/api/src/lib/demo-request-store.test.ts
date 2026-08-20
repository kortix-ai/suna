// Unit coverage for the contact_forms write that POST /v1/system/demo-request
// owns. Hermetic: `../shared/db` is mocked, so this asserts the statement and
// the parameter the store issues, plus every best-effort failure path.
// The real row round-trip is proven in
// src/__tests__/integration-demo-request-store.test.ts.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

interface Executed {
  text: string;
  params: unknown[];
}

const executed: Executed[] = [];
let failWith: Error | null = null;

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    execute: async (query: any) => {
      // drizzle's SQL object: `toQuery` needs a dialect, so read the chunks the
      // template produced directly — a StringChunk ({value: string[]}) is
      // literal SQL, anything else is a bound parameter.
      const chunks: unknown[] = query.queryChunks ?? [];
      let text = '';
      const params: unknown[] = [];
      for (const chunk of chunks) {
        const literal = (chunk as any)?.value;
        if (Array.isArray(literal)) text += literal.join('');
        else params.push(chunk);
      }
      executed.push({ text, params });
      if (failWith) throw failWith;
      return [] as any;
    },
  },
}));

const { recordDemoRequestSubmission } = await import('./demo-request-store');

const consoleError = console.error;
let logged: string[] = [];

beforeEach(() => {
  executed.length = 0;
  failWith = null;
  logged = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  console.error = consoleError;
});

describe('recordDemoRequestSubmission', () => {
  test('writes one contact_forms row with the submission verbatim', async () => {
    const ok = await recordDemoRequestSubmission({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      company_name: 'Analytical Engines',
      company_size: '51-200',
      goal: 'automate inbound triage',
      qualified: true,
      source: 'contact',
      form: 'contact',
      user_agent: 'Mozilla/5.0 (probe)',
      // Unknown keys a form added without a migration (the careers form).
      opening: 'Founding engineer',
      owned: 'shipped a payments platform',
    });

    expect(ok).toBe(true);
    expect(executed).toHaveLength(1);
    expect(executed[0].text).toBe('INSERT INTO public.contact_forms (data) VALUES (::jsonb)');
    expect(executed[0].params).toHaveLength(1);

    const stored = JSON.parse(executed[0].params[0] as string);
    expect(stored).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      company_name: 'Analytical Engines',
      company_size: '51-200',
      goal: 'automate inbound triage',
      qualified: true,
      source: 'contact',
      form: 'contact',
      user_agent: 'Mozilla/5.0 (probe)',
      opening: 'Founding engineer',
      owned: 'shipped a payments platform',
    });
  });

  test('swallows an insert failure (a missing table never fails lead capture)', async () => {
    failWith = new Error('relation "public.contact_forms" does not exist');
    expect(await recordDemoRequestSubmission({ email: 'a@b.co' })).toBe(false);
    expect(executed).toHaveLength(1);
    expect(logged.join('\n')).toContain('contact_forms insert failed');
  });

  test('caps an over-sized payload to the fields the notification renders', async () => {
    const ok = await recordDemoRequestSubmission({
      email: 'flood@example.com',
      name: 'Flooder',
      source: 'contact',
      form: 'contact',
      goal: 'g'.repeat(5000),
      user_agent: null,
      junk: 'x'.repeat(70_000),
    });

    expect(ok).toBe(true);
    const stored = JSON.parse(executed[0].params[0] as string);
    expect(stored.truncated).toBe(true);
    expect(stored.junk).toBeUndefined();
    expect(stored.email).toBe('flood@example.com');
    expect(stored.goal).toHaveLength(2000);
    expect((executed[0].params[0] as string).length).toBeLessThan(64 * 1024);
  });

  test('returns false on a payload that cannot be serialized', async () => {
    const cyclic: Record<string, unknown> = { email: 'a@b.co' };
    cyclic.self = cyclic;
    expect(await recordDemoRequestSubmission(cyclic)).toBe(false);
    expect(executed).toHaveLength(0);
    expect(logged.join('\n')).toContain('not serializable');
  });
});
