import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SPAN_ATTRIBUTES,
  activeHeaderRows,
  buildHeadersPayload,
  endpointHostname,
  headerRowsValid,
  isValidOtelEndpoint,
} from './gateway-observability';

const observabilitySource = readFileSync(
  join(import.meta.dir, 'gateway-observability.tsx'),
  'utf8',
);
const gatewayViewSource = readFileSync(join(import.meta.dir, '../../gateway-view.tsx'), 'utf8');

function row(name: string, value: string, id = crypto.randomUUID()) {
  return { id, name, value };
}

describe('isValidOtelEndpoint', () => {
  test('accepts an https URL', () => {
    expect(isValidOtelEndpoint('https://otel.example.com/v1/traces')).toBe(true);
  });

  test('rejects http (must match the API SSRF guard: https-only)', () => {
    expect(isValidOtelEndpoint('http://otel.example.com/v1/traces')).toBe(false);
  });

  test('rejects a non-URL string', () => {
    expect(isValidOtelEndpoint('not a url')).toBe(false);
  });

  test('rejects an empty string', () => {
    expect(isValidOtelEndpoint('')).toBe(false);
  });
});

describe('endpointHostname', () => {
  test('extracts the hostname for display', () => {
    expect(endpointHostname('https://cloud.langfuse.com/api/public/otel/v1/traces')).toBe(
      'cloud.langfuse.com',
    );
  });

  test('falls back to the raw value when it does not parse — never throws', () => {
    expect(endpointHostname('not a url')).toBe('not a url');
  });
});

describe('activeHeaderRows / headerRowsValid', () => {
  test('an all-blank row is not active', () => {
    expect(activeHeaderRows([row('', '')])).toEqual([]);
    expect(headerRowsValid([row('', '')])).toBe(true); // vacuously valid — nothing to send
  });

  test('a fully-filled row is active and valid', () => {
    const r = row('Authorization', 'Bearer tok');
    expect(activeHeaderRows([r])).toEqual([r]);
    expect(headerRowsValid([r])).toBe(true);
  });

  test('a half-filled row (name only, or value only) is active but invalid', () => {
    expect(headerRowsValid([row('Authorization', '')])).toBe(false);
    expect(headerRowsValid([row('', 'Bearer tok')])).toBe(false);
  });

  test('one valid row alongside one blank row is still valid overall', () => {
    expect(headerRowsValid([row('Authorization', 'Bearer tok'), row('', '')])).toBe(true);
  });
});

describe('buildHeadersPayload', () => {
  test('returns undefined when every row is blank — leaves stored headers untouched', () => {
    expect(buildHeadersPayload([row('', '')])).toBeUndefined();
  });

  test('builds a name→value map from filled rows, trimming whitespace', () => {
    expect(
      buildHeadersPayload([row('  Authorization  ', '  Bearer tok  '), row('X-Extra', 'v')]),
    ).toEqual({ Authorization: 'Bearer tok', 'X-Extra': 'v' });
  });

  test('drops blank rows mixed in with filled ones', () => {
    expect(buildHeadersPayload([row('Authorization', 'Bearer tok'), row('', '')])).toEqual({
      Authorization: 'Bearer tok',
    });
  });
});

describe('wiring — Observability tab is mounted with the shared canWrite gate', () => {
  test('gateway-view.tsx imports and mounts GatewayObservability inside the tab bar', () => {
    expect(gatewayViewSource).toContain(
      "import { GatewayObservability } from '@/features/workspace/customize/sections/view/gateway/gateway-observability';",
    );
    expect(gatewayViewSource).toContain(
      '<GatewayObservability projectId={projectId} canWrite={canWrite} />',
    );
    expect(gatewayViewSource).toContain("{ id: 'observability', label: 'Observability' }");
  });

  test('edit/disconnect/toggle controls are narrowed by the server capability, not just the coarse flag', () => {
    expect(observabilitySource).toContain('data?.capabilities?.write !== false');
  });

  test('editing never silently re-enables a paused destination', () => {
    expect(observabilitySource).toContain('initialEnabled={data?.endpoint ? data.enabled : true}');
    expect(observabilitySource).toContain('enabled: initialEnabled');
  });
});

describe('the connect form opens clean — no error before the user types', () => {
  // Regression: the modal used to seed `{ name: 'Authorization', value: '' }`,
  // a half-filled row, so `headerRowsValid` was false on open and the red
  // "Fill in both the header name and value" line rendered on an untouched
  // form. Verified in the browser at /projects/:id/models → Observability.
  test('the seed header row is blank, so the untouched form is valid', () => {
    expect(observabilitySource).toContain('useState<HeaderRow[]>([emptyHeaderRow()])');
    expect(observabilitySource).not.toContain("name: 'Authorization', value: ''");
    expect(headerRowsValid([row('', '')])).toBe(true);
    expect(buildHeadersPayload([row('', '')])).toBeUndefined();
  });
});

// The "What gets sent" list is a promise about the wire, made on a screen that
// cannot see the wire. `emitGatewayGenAiSpan` (apps/api) is the only thing that
// decides what a span carries, and it has already grown twice since this tab
// was written. Greping the real source is the cheapest way to make the list
// impossible to drift: rename or drop an attribute in the API and this fails.
describe('SPAN_ATTRIBUTES mirrors the attributes the API actually emits', () => {
  const hooksSource = readFileSync(
    join(import.meta.dir, '../../../../../../../../api/src/llm-gateway/hooks.ts'),
    'utf8',
  );

  test('the API hooks file is the one that builds the gen_ai span', () => {
    expect(hooksSource).toContain('export function emitGatewayGenAiSpan');
  });

  for (const attr of SPAN_ATTRIBUTES) {
    test(`emitGatewayGenAiSpan sets ${attr.key}`, () => {
      expect(hooksSource).toContain(`'${attr.key}'`);
    });
  }

  test('every listed key has a human description and no duplicates', () => {
    expect(new Set(SPAN_ATTRIBUTES.map((a) => a.key)).size).toBe(SPAN_ATTRIBUTES.length);
    for (const a of SPAN_ATTRIBUTES) expect(a.desc.length).toBeGreaterThan(3);
  });
});
