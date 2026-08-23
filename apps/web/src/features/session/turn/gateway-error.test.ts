// The three real error shapes seen on 2026-08-22 (a sandbox whose OpenCode
// still pointed at a rotated KORTIX_URL) — plus a non-gateway APIError that
// must stay 'other' — against the pure classifier the timeline error row uses.
import { describe, expect, test } from 'bun:test';

import {
  GATEWAY_UNREACHABLE_DETAIL,
  GATEWAY_UNREACHABLE_TITLE,
  classifyGatewayTurnError,
} from './gateway-error';

const GATEWAY_URL =
  'https://edt-skirt-example.trycloudflare.com/v1/llm-gateway/v1/chat/completions';

describe('classifyGatewayTurnError', () => {
  test('"Cannot connect to API: Unable to connect…" → gateway-unreachable, human title + detail, raw kept', () => {
    const error = {
      name: 'APIError',
      data: {
        message:
          'Cannot connect to API: Unable to connect. Is the computer able to access the url?',
        isRetryable: true,
        metadata: { url: GATEWAY_URL },
      },
    };
    const out = classifyGatewayTurnError(error);
    expect(out.kind).toBe('gateway-unreachable');
    expect(out.title).toBe(GATEWAY_UNREACHABLE_TITLE);
    expect(out.title).toBe("Couldn't reach the Kortix gateway from the sandbox");
    expect(out.detail).toBe(GATEWAY_UNREACHABLE_DETAIL);
    expect(out.detail).toBe(
      'The sandbox could not connect to the model gateway for this turn. It reconnects on the next message — resend to continue.',
    );
    expect(out.raw).toBe(
      'Cannot connect to API: Unable to connect. Is the computer able to access the url?',
    );
  });

  test('"Cannot connect to API: Was there a typo in the url or port?" → gateway-unreachable (no url on the error)', () => {
    const out = classifyGatewayTurnError({
      name: 'APIError',
      data: {
        message: 'Cannot connect to API: Was there a typo in the url or port?',
        isRetryable: true,
      },
    });
    expect(out.kind).toBe('gateway-unreachable');
    expect(out.raw).toBe('Cannot connect to API: Was there a typo in the url or port?');
  });

  test('statusCode 530 with message "<none>" at …/v1/llm-gateway/v1/chat/completions → gateway-unreachable', () => {
    const out = classifyGatewayTurnError({
      name: 'APIError',
      data: {
        message: '<none>',
        statusCode: 530,
        isRetryable: true,
        metadata: { url: GATEWAY_URL },
      },
    });
    expect(out.kind).toBe('gateway-unreachable');
    expect(out.title).toBe(GATEWAY_UNREACHABLE_TITLE);
    expect(out.raw).toContain('530');
  });

  test('statusCode 502/503 with an empty message at /v1/llm/ (non-proxy mode path) → gateway-unreachable', () => {
    for (const statusCode of [502, 503]) {
      const out = classifyGatewayTurnError({
        name: 'APIError',
        data: {
          message: '',
          statusCode,
          metadata: { url: 'https://dev-api.kortix.com/v1/llm/chat/completions' },
        },
      });
      expect(out.kind).toBe('gateway-unreachable');
    }
  });

  test('statusCode 530 with an empty message at a NON-gateway url → other', () => {
    const out = classifyGatewayTurnError({
      name: 'APIError',
      data: { message: '<none>', statusCode: 530, metadata: { url: 'https://api.example.com/v2' } },
    });
    expect(out.kind).toBe('other');
  });

  test('a gateway APIError with a real status and a real message → gateway-http (rendering unchanged)', () => {
    const out = classifyGatewayTurnError({
      name: 'APIError',
      data: {
        message: 'model_not_found: no upstream serves claude-x',
        statusCode: 404,
        metadata: { url: GATEWAY_URL },
      },
    });
    expect(out.kind).toBe('gateway-http');
    expect(out.title).toBe('Kortix gateway returned HTTP 404');
    expect(out.detail).toBe('model_not_found: no upstream serves claude-x');
  });

  test('a non-gateway APIError stays other', () => {
    const out = classifyGatewayTurnError({
      name: 'APIError',
      data: { message: 'Provider exploded' },
    });
    expect(out.kind).toBe('other');
    expect(out.raw).toBe('Provider exploded');
  });

  test('"Cannot connect" against a non-gateway url is NOT the gateway (a webfetch-style failure stays other)', () => {
    const out = classifyGatewayTurnError({
      name: 'APIError',
      data: {
        message: 'Cannot connect to API: Unable to connect.',
        metadata: { url: 'https://api.openai.com/v1/chat/completions' },
      },
    });
    expect(out.kind).toBe('other');
  });

  test('abort / unknown / string / null inputs → other, never throws', () => {
    expect(
      classifyGatewayTurnError({ name: 'MessageAbortedError', data: { message: 'aborted' } }).kind,
    ).toBe('other');
    expect(classifyGatewayTurnError('plain string').kind).toBe('other');
    expect(classifyGatewayTurnError(null).kind).toBe('other');
    expect(classifyGatewayTurnError(undefined).kind).toBe('other');
    expect(classifyGatewayTurnError(42).kind).toBe('other');
  });

  test('a JSON-serialized error object is unwrapped before classification', () => {
    const out = classifyGatewayTurnError(
      JSON.stringify({
        name: 'APIError',
        data: { message: 'fetch failed', metadata: { url: GATEWAY_URL } },
      }),
    );
    expect(out.kind).toBe('gateway-unreachable');
  });
});
