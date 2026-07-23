// `export {}` forces module mode: a file with no top-level import/export is a
// script to TS, where top-level `await` is rejected and `screen` below would
// merge with the ambient DOM `Screen` global instead of testing-library's type.
export {};

// Same `@happy-dom/global-registrator` + dynamic-import dance
// `gateway-view.test.tsx` establishes — a plain static
// `import { screen } from '@testing-library/react'` evaluates before
// `GlobalRegistrator` registers (ESM hoists static imports), leaving `screen`
// stuck on its permanently-throwing "no document" stub. Only dynamic
// `import()` under top-level `await` forces registration first.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, render, screen } = await import('@testing-library/react');
const ReactModule = await import('react');

// `GatewayApiAccess` is pure composition (Task 18) — it owns no data
// fetching itself, so its two real children are stubbed to plain markers
// that record the props they received, same convention `gateway-view.test.tsx`
// uses for every heavy per-surface view.
let gatewayKeysProps: Record<string, unknown> | null = null;
let apiReferenceProps: Record<string, unknown> | null = null;

mock.module('@/features/workspace/customize/sections/view/gateway/gateway-keys', () => ({
  GatewayKeys: (props: Record<string, unknown>) => {
    gatewayKeysProps = props;
    return ReactModule.createElement('div', null, 'GatewayKeys marker');
  },
}));
mock.module('@/features/workspace/customize/sections/view/gateway/gateway-api-reference', () => ({
  GatewayApiReference: (props: Record<string, unknown>) => {
    apiReferenceProps = props;
    return ReactModule.createElement('div', null, 'GatewayApiReference marker');
  },
}));

const { GatewayApiAccess } = await import('./gateway-api-access');

afterEach(() => {
  cleanup();
  gatewayKeysProps = null;
  apiReferenceProps = null;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('GatewayApiAccess — Task 18 merged API access panel', () => {
  test('renders the keys block above the API reference block in one scroll container', () => {
    render(<GatewayApiAccess projectId="proj_1" canWrite gatewayUrl={null} />);

    const keys = screen.getByText('GatewayKeys marker');
    const reference = screen.getByText('GatewayApiReference marker');
    expect(keys).toBeDefined();
    expect(reference).toBeDefined();
    // DOM order: keys precede the reference (stacked in one scroll region).
    expect(
      Boolean(keys.compareDocumentPosition(reference) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  test('passes projectId/canWrite/gatewayUrl through, with no extra tab-hop callback prop', () => {
    render(<GatewayApiAccess projectId="proj_1" canWrite gatewayUrl="https://gw.example.com" />);

    expect(gatewayKeysProps?.projectId).toBe('proj_1');
    expect(gatewayKeysProps?.canWrite).toBe(true);
    // Exact prop shape — guards against a stray callback prop creeping back in.
    expect(Object.keys(gatewayKeysProps ?? {}).sort()).toEqual(['canWrite', 'projectId']);

    expect(apiReferenceProps?.gatewayUrl).toBe('https://gw.example.com');
    expect(typeof apiReferenceProps?.apiKey).toBe('string');
    expect(Object.keys(apiReferenceProps ?? {}).sort()).toEqual(['apiKey', 'gatewayUrl']);
  });

  test('reference block heading reads "Use these models from your code" (spec 3c)', () => {
    render(<GatewayApiAccess projectId="proj_1" canWrite gatewayUrl={null} />);

    expect(screen.getByText('Use these models from your code')).toBeDefined();
    expect(screen.queryByText(/call the gateway/i)).toBeNull();
  });
});
