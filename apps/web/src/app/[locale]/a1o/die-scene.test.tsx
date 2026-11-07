import { afterEach, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { __resetWebGL2ProbeForTests } from '@kortix/ui/shader-safe';

// R3F's <Canvas> builds THREE.WebGLRenderer inside an async configure() that it
// never awaits, so on a client with no WebGL2 the constructor's throw escapes
// every error boundary as an unhandled rejection (Better Stack pattern
// `25c66311…`, /a1o, VENDOR = 0xffff). DieScene must not mount <Canvas> there.
let canvasMounts = 0;
mock.module('@react-three/fiber', () => ({
  Canvas: () => {
    canvasMounts += 1;
    return createElement('canvas');
  },
  useFrame: () => {},
  useThree: () => ({}),
}));

const { default: DieScene } = await import('./die-scene');

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function installBrowser(webgl2: object | null): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({ getContext: (type: string) => (type === 'webgl2' ? webgl2 : null) }) },
  });
}

let renderer: ReactTestRenderer | undefined;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  canvasMounts = 0;
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'document');
  __resetWebGL2ProbeForTests();
});

function renderScene(): void {
  act(() => {
    renderer = create(
      createElement(DieScene, { rollToken: 1, spinToken: 0, onSettle: () => {}, onImpact: () => {} }),
    );
  });
}

test('DieScene renders the placeholder and never mounts <Canvas> when WebGL2 is unavailable', () => {
  installBrowser(null);
  renderScene();
  expect(canvasMounts).toBe(0);
  expect(renderer?.root.findByType('div').props['aria-hidden']).toBe(true);
});

test('DieScene mounts <Canvas> when WebGL2 works', () => {
  installBrowser({ getSupportedExtensions: () => [] });
  renderScene();
  expect(canvasMounts).toBeGreaterThan(0);
});
