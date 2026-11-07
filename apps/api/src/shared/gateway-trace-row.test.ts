import { describe, test, expect } from 'bun:test';
import { buildGatewayTraceRow, type GatewayTraceInput } from './gateway-trace-row';

// Built via fromCharCode so this test file stays pure ASCII: a literal NUL byte
// in source would make it a binary file.
const NUL = String.fromCharCode(0);
const NUL_JSON_ESCAPE = String.fromCharCode(92) + 'u0000';

function baseInput(overrides: Partial<GatewayTraceInput> = {}): GatewayTraceInput {
  return {
    requestId: 'req_1',
    accountId: 'acc_1',
    requestedModel: 'claude',
    resolvedModel: 'claude',
    provider: 'bedrock',
    status: 200,
    ok: true,
    ...overrides,
  };
}

describe('buildGatewayTraceRow', () => {
  test('strips NUL bytes from the request body (the column Postgres rejected)', () => {
    const row = buildGatewayTraceRow(
      baseInput({
        request: {
          messages: [{ role: 'system', content: `How you work${NUL} step 1` }],
        },
      }),
    );
    expect(JSON.stringify(row.request).includes(NUL_JSON_ESCAPE)).toBe(false);
    expect((row.request as any).messages[0].content).toBe('How you work step 1');
  });

  test('strips NUL bytes from response, metadata, candidatesTried, and errorMessage', () => {
    const row = buildGatewayTraceRow(
      baseInput({
        ok: false,
        errorMessage: `boom${NUL}`,
        candidatesTried: [`model${NUL}a`, 'model-b'],
        response: { output: `text${NUL}` },
        metadata: { note: `meta${NUL}data` },
      }),
    );
    const serialized = JSON.stringify(row);
    expect(serialized.includes(NUL_JSON_ESCAPE)).toBe(false);
    expect(row.errorMessage).toBe('boom');
    expect(row.candidatesTried).toEqual(['modela', 'model-b']);
    expect((row.response as any).output).toBe('text');
    expect((row.metadata as any).note).toBe('metadata');
  });

  test('wraps a non-object request payload under `value` and still scrubs it', () => {
    const row = buildGatewayTraceRow(baseInput({ request: `raw${NUL}body` }));
    expect(row.request).toEqual({ value: 'rawbody' });
  });

  test('null request/response become null; metadata defaults to {}', () => {
    const row = buildGatewayTraceRow(baseInput());
    expect(row.request).toBeNull();
    expect(row.response).toBeNull();
    expect(row.metadata).toEqual({});
    expect(row.candidatesTried).toEqual([]);
  });

  test('clean payloads pass through unchanged', () => {
    const request = { messages: [{ role: 'user', content: 'hi' }] };
    const row = buildGatewayTraceRow(baseInput({ request }));
    expect(row.request).toEqual(request);
  });
});

describe('buildGatewayTraceRow metadata bound (KRTX-4022)', () => {
  // metadata is an INCLUDE column of idx_gateway_logs_project_time_covering_v2;
  // a btree tuple over ~2.7 KB makes the INSERT of the whole trace row fail.
  const BOUND = 2000;
  const failure = (attempt: number, message: string) => ({
    attempt,
    provider: 'openai',
    routeModel: 'gpt-6.1-sol',
    resolvedModel: 'gpt-6.1-sol',
    stage: 'dispatch',
    status: 502,
    code: 502,
    message,
  });
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

  test('multi-attempt failures with huge upstream messages stay under the index-tuple bound', () => {
    const attemptFailures = Array.from({ length: 6 }, (_, i) => failure(i + 1, `${i}`.repeat(20_000)));
    const row = buildGatewayTraceRow(baseInput({ metadata: { usageEstimated: false, servedModel: 'm', attemptFailures } }));
    expect(bytes(row.metadata)).toBeLessThanOrEqual(BOUND);
    const kept = (row.metadata as any).attemptFailures;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept[0]).toMatchObject({ attempt: 1, provider: 'openai', status: 502, code: 502 });
    expect((row.metadata as any).usageEstimated).toBe(false);
    expect((row.metadata as any).servedModel).toBe('m');
  });

  test('multi-byte text is bounded by bytes, not characters', () => {
    const attemptFailures = [failure(1, '\u{1F600}'.repeat(5000))];
    const row = buildGatewayTraceRow(baseInput({ metadata: { attemptFailures } }));
    expect(bytes(row.metadata)).toBeLessThanOrEqual(BOUND);
  });

  test('metadata already under the bound is stored untouched', () => {
    const metadata = { usageEstimated: true, attemptFailures: [failure(1, 'upstream said no')] };
    expect(buildGatewayTraceRow(baseInput({ metadata })).metadata).toEqual(metadata);
  });
});
