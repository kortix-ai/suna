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

  // KRTX-4023: the dashboard aggregates read served_model / usage_estimated
  // as real columns (a jsonb expression cannot join the covering indexes'
  // INCLUDE lists) — the writer must lift the metadata keys into them.
  test('lifts the servedModel and usageEstimated metadata keys into columns', () => {
    const row = buildGatewayTraceRow(
      baseInput({ metadata: { servedModel: 'gpt-6.1-sol', usageEstimated: true } }),
    );
    expect(row.servedModel).toBe('gpt-6.1-sol');
    expect(row.usageEstimated).toBe(true);
  });

  test('an explicit false flag reads false; a missing key reads null (the pre-promotion shape)', () => {
    const explicit = buildGatewayTraceRow(baseInput({ metadata: { usageEstimated: false } }));
    expect(explicit.usageEstimated).toBe(false);
    expect(explicit.servedModel).toBeNull();

    const absent = buildGatewayTraceRow(baseInput());
    expect(absent.servedModel).toBeNull();
    expect(absent.usageEstimated).toBe(false);
  });

  test('a non-string servedModel value never reaches the column', () => {
    const row = buildGatewayTraceRow(
      baseInput({ metadata: { servedModel: 42, usageEstimated: 'yes' } }),
    );
    expect(row.servedModel).toBeNull();
    // The SQL flag is the strict boolean the emit writes; a stray string is
    // not a trusted 'true'.
    expect(row.usageEstimated).toBe(false);
  });
});
