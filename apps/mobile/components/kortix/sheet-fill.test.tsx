/**
 * SheetFill: the visible sheet edge, without a layout on every frame.
 *
 * The body's laid-out height changes only when the sheet settles, when an
 * animation starts toward a taller target, or while a drag shows more sheet
 * than the body covers. Everywhere else the body keeps its height and the
 * `PinnedBar` moves up by `shift` (a transform), so the bar's bottom stays on
 * the visible edge on every frame: `height + shift === visible`.
 *
 * The render tests run on a model of Reanimated's mapper registry
 * (`react-native-reanimated/src/mappers.ts`): mappers sorted topologically by
 * declared outputs, else in registration order; a shared value set while the
 * mappers run marks an already-run mapper dirty for the NEXT frame. React
 * registers a child's mappers before its parent's (effects run child-first),
 * so this catches a bar transform that lands one frame after the height.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';

// `react-test-renderer` ships no types in this workspace: type the part this test uses.
type TestNode = { props: Record<string, unknown> };
type ReactTestRenderer = {
  root: { findByType: (type: never) => TestNode; findAllByType: (type: never) => TestNode[] };
  update: (element: React.ReactElement) => void;
  unmount: () => void;
};
const { act, create } = require('react-test-renderer') as {
  act: (fn: () => void) => void;
  create: (element: React.ReactElement) => ReactTestRenderer;
};

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);

// Values copied from `@gorhom/bottom-sheet` `src/constants.ts` (5.2.x) and
// `react-native-gesture-handler` `src/State.ts`.
const ANIMATION_STATUS = { UNDETERMINED: 0, RUNNING: 1, STOPPED: 2, INTERRUPTED: 3 } as const;
const GESTURE = { UNDETERMINED: 0, FAILED: 1, BEGAN: 2, CANCELLED: 3, ACTIVE: 4, END: 5 } as const;

// A shared value as `mutables.ts` + `valueSetter.ts` behave: setting the same
// value notifies no one; a new value notifies every listening mapper.
type Shared<T> = { value: T; get: () => T; set: (v: T) => void; listeners: Map<number, () => void>; __shared: true };
const shared = <T,>(value: T): Shared<T> => {
  const sv = { value, listeners: new Map(), __shared: true } as Shared<T>;
  sv.get = () => sv.value;
  sv.set = (v: T) => {
    if (v === sv.value) return;
    sv.value = v;
    sv.listeners.forEach((listener) => listener());
  };
  return sv;
};
const isShared = (v: unknown): v is Shared<unknown> => !!v && (v as Shared<unknown>).__shared === true;

type Anim = { status: number; nextIndex?: number; nextPosition?: number };
const sheet = {
  animatedLayoutState: shared({ containerHeight: 800, handleHeight: 60 }),
  animatedPosition: shared(800),
  animatedAnimationState: shared<Anim>({ status: ANIMATION_STATUS.UNDETERMINED }),
  animatedContentGestureState: shared<number>(GESTURE.UNDETERMINED),
  animatedHandleGestureState: shared<number>(GESTURE.UNDETERMINED),
};

mock.module('react-native', () => ({
  Keyboard: { dismiss: () => {} },
  StyleSheet: { absoluteFill: { position: 'absolute' } },
  View: host('view'),
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
mock.module('react-native-gesture-handler', () => ({ State: GESTURE }));
mock.module('@gorhom/bottom-sheet', () => ({
  ANIMATION_STATUS,
  BottomSheetModal: host('bottom-sheet-modal'),
  BottomSheetView: host('bottom-sheet-view'),
  BottomSheetBackdrop: host('bottom-sheet-backdrop'),
  useBottomSheetModal: () => ({ dismiss: () => {} }),
  useBottomSheetInternal: () => sheet,
}));
// ─── A model of Reanimated 4.3.1's mapper registry (`src/mappers.ts`) ───────
type Mapper = { id: number; dirty: boolean; worklet: () => void; inputs: Shared<unknown>[]; outputs?: Shared<unknown>[] };
const registry = (() => {
  let nextId = 0;
  const mappers = new Map<number, Mapper>();
  let sorted: Mapper[] = [];
  let processing = false;
  // Same algorithm as `updateMappersOrder`: DFS over the transposed graph.
  const order = () => {
    const pre = new Map<unknown, Mapper[]>();
    mappers.forEach((m) => m.outputs?.forEach((o) => pre.set(o, [...(pre.get(o) ?? []), m])));
    const visited = new Set<Mapper>();
    const out: Mapper[] = [];
    const dfs = (m: Mapper) => {
      visited.add(m);
      for (const input of m.inputs) for (const p of pre.get(input) ?? []) if (!visited.has(p)) dfs(p);
      out.push(m);
    };
    mappers.forEach((m) => !visited.has(m) && dfs(m));
    sorted = out;
  };
  return {
    start(worklet: () => void, inputs: unknown[], outputs?: Shared<unknown>[]) {
      const m: Mapper = { id: nextId++, dirty: true, worklet, inputs: inputs.filter(isShared), outputs };
      mappers.set(m.id, m);
      sorted = [];
      for (const sv of m.inputs) sv.listeners.set(m.id, () => (m.dirty = true));
      return m.id;
    },
    stop(id: number) {
      const m = mappers.get(id);
      if (!m) return;
      mappers.delete(id);
      sorted = [];
      for (const sv of m.inputs) sv.listeners.delete(id);
    },
    /** One frame's `mapperRun`. A mapper dirtied after its turn waits for the next frame. */
    frame() {
      processing = true;
      try {
        if (mappers.size !== sorted.length) order();
        for (const m of sorted) {
          if (m.dirty) {
            m.dirty = false;
            m.worklet();
          }
        }
      } finally {
        processing = false;
      }
    },
    get processing() {
      return processing;
    },
  };
})();

type AnimatedStyle = { __animated: true; current: Record<string, unknown> };
mock.module('react-native-reanimated', () => ({
  default: { View: host('animated-view') },
  useSharedValue: <T,>(value: T) => React.useRef(shared(value)).current,
  // Registers with its output: sorted before every mapper that reads it.
  useDerivedValue: <T,>(updater: () => T, deps: unknown[] = []) => {
    const ref = React.useRef<Shared<T> | null>(null);
    if (!ref.current) ref.current = shared(updater());
    const sv = ref.current;
    React.useEffect(() => {
      const id = registry.start(() => sv.set(updater()), deps, [sv as Shared<unknown>]);
      return () => registry.stop(id);
    }, []);
    return sv;
  },
  // Registers with no outputs (`useAnimatedReaction.ts:68`).
  useAnimatedReaction: <T,>(prepare: () => T, react: (next: T, prev: T | null) => void, deps: unknown[] = []) => {
    React.useEffect(() => {
      const id = registry.start(() => react(prepare(), null), deps);
      return () => registry.stop(id);
    }, []);
  },
  useAnimatedStyle: (worklet: () => Record<string, unknown>, deps: unknown[] = []) => {
    const style = React.useRef<AnimatedStyle>({ __animated: true, current: worklet() }).current;
    React.useEffect(() => {
      const id = registry.start(() => (style.current = worklet()), deps);
      return () => registry.stop(id);
    }, []);
    return style;
  },
}));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 20 }) }));
mock.module('expo-linear-gradient', () => ({ LinearGradient: host('linear-gradient') }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('@/lib/theme-colors', () => ({ getSheetBg: () => 'sheet-bg' }));
mock.module('@/lib/utils/theme', () => ({
  THEME: { light: { border: 'b' }, dark: { border: 'b', background: 'bg' } },
  withAlpha: (color: string, alpha: number) => `${color}@${alpha}`,
}));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/ui/icon', () => ({ Icon: host('icon') }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('expo-clipboard', () => ({ setStringAsync: async () => {} }));
mock.module('@/lib/haptics', () => ({ haptics: { success: () => {} } }));
mock.module('@/lib/icons', () => ({ CheckIcon: 'check', CopyIcon: 'copy', XIcon: 'x' }));

let mod: typeof import('./sheet');
let bar: typeof import('./pinned-bar');
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mod = await import('./sheet');
  bar = await import('./pinned-bar');
});

const layout = { containerHeight: 800, handleHeight: 60 };
const visibleAt = (position: number) => Math.max(0, 800 - position - 60);
const running = (nextPosition: number, nextIndex: number): Anim => ({
  status: ANIMATION_STATUS.RUNNING,
  nextIndex,
  nextPosition,
});
const stopped: Anim = { status: ANIMATION_STATUS.STOPPED };

const fillLayout = (
  l: { containerHeight: number; handleHeight: number },
  position: number,
  anim: Anim,
  gesture: boolean,
  prev: number | null
) => {
  const height = mod.sheetFillHeight(l, position, anim, gesture, prev);
  return { height, shift: mod.sheetFillShift(l, position, height) };
};

describe('sheetFillHeight and sheetFillShift', () => {
  const step = (position: number, anim: Anim, gesture: boolean, prev: number | null) =>
    fillLayout(layout, position, anim, gesture, prev);

  test('no height and no shift until the container is measured', () => {
    expect(fillLayout({ containerHeight: -999, handleHeight: -999 }, 0, stopped, false, null)).toEqual({
      height: null,
      shift: 0,
    });
  });

  test('at rest: exactly the visible sheet, no shift (as before)', () => {
    expect(step(100, stopped, false, null)).toEqual({ height: 640, shift: 0 });
    // Settling at a lower detent is the one layout of a move down.
    expect(step(160, stopped, false, 640)).toEqual({ height: 580, shift: 0 });
  });

  test('an unmeasured handle counts as 0', () => {
    expect(fillLayout({ containerHeight: 800, handleHeight: -999 }, 100, stopped, false, null)).toEqual({
      height: 700,
      shift: 0,
    });
  });

  test('open: laid out once at the target detent; the bar stays on the visible edge', () => {
    let prev: number | null = null;
    for (const position of [800, 700, 450, 200, 100]) {
      const next = step(position, running(100, 0), false, prev);
      expect(next.height).toBe(640);
      expect(next.height! + next.shift).toBe(visibleAt(position));
      prev = next.height;
    }
  });

  test('close: keeps its height; the bar rides the visible edge down', () => {
    for (const position of [100, 300, 600, 800]) {
      const next = step(position, running(800, -1), false, 640);
      expect(next.height).toBe(640);
      expect(next.height! + next.shift).toBe(visibleAt(position));
    }
  });

  test('drag down: keeps its height, the bar follows by transform', () => {
    expect(step(160, stopped, true, 640)).toEqual({ height: 640, shift: -60 });
  });

  test('drag up past the laid-out height: grows with the drag, so no band shows under the list', () => {
    expect(step(100, stopped, true, 580)).toEqual({ height: 640, shift: 0 });
    expect(step(40, stopped, true, 640)).toEqual({ height: 700, shift: 0 });
  });

  test('an animation toward a taller target lays out once at that target', () => {
    // Snap up from 160 (580) to 50 (690).
    for (const position of [160, 120, 50]) {
      const next = step(position, running(50, 1), false, 580);
      expect(next.height).toBe(690);
      expect(next.height! + next.shift).toBe(visibleAt(position));
    }
  });

  test('an animation toward a shorter target keeps the height until it settles', () => {
    const next = step(150, running(300, 0), false, 640);
    expect(next).toEqual({ height: 640, shift: -50 });
  });

  test('keyboard up: one layout at the lifted position; keyboard down: transform, then one layout', () => {
    expect(step(100, running(-100, 1), false, 640)).toEqual({ height: 840, shift: -200 });
    expect(step(-100, stopped, false, 840)).toEqual({ height: 840, shift: 0 });
    expect(step(0, running(100, 1), false, 840)).toEqual({ height: 840, shift: -100 });
    expect(step(100, stopped, false, 840)).toEqual({ height: 640, shift: 0 });
  });

  test('a mount interrupted by the keyboard sizes to the lifted target', () => {
    const mounting = step(500, running(100, 0), false, null);
    expect(mounting.height).toBe(640);
    expect(step(450, running(-100, 1), false, mounting.height)).toEqual({ height: 840, shift: -550 });
  });

  test('invariant over random moves: the bar sits on the visible edge, never above a gap', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    let prev: number | null = null;
    for (let i = 0; i < 5000; i++) {
      const position = Math.round(rnd() * 900) - 100;
      const kind = Math.floor(rnd() * 4);
      const anim =
        kind === 0 ? stopped : kind === 1 ? running(Math.round(rnd() * 900) - 100, 0) : running(800, -1);
      const gesture = kind === 3;
      const next = fillLayout(layout, position, anim, gesture, prev);
      const visible = visibleAt(position);
      expect(next.height).not.toBeNull();
      expect(next.height! + next.shift).toBe(visible);
      expect(next.shift).toBeLessThanOrEqual(0);
      if (kind === 0) expect(next).toEqual({ height: visible, shift: 0 });
      prev = next.height;
    }
  });
});

describe('SheetFill with a PinnedBar, on the mapper registry model', () => {
  const resolve = (style: unknown): Record<string, unknown> =>
    Object.assign(
      {},
      ...(Array.isArray(style) ? style : [style])
        .filter(Boolean)
        .map((s) => ((s as AnimatedStyle).__animated ? (s as AnimatedStyle).current : s))
    );
  const read = (t: ReactTestRenderer) => {
    const [fill, barRoot] = t.root.findAllByType('animated-view' as never);
    const height = resolve(fill.props.style).height as number | undefined;
    const transform = resolve(barRoot.props.style).transform as { translateY: number }[] | undefined;
    return { height, translateY: transform?.[0].translateY };
  };
  const element = () => (
    <mod.SheetFill style={{ paddingTop: 4 }}>
      <bar.PinnedBar controlHeight={40} background="bg">
        <></>
      </bar.PinnedBar>
    </mod.SheetFill>
  );
  const mount = () => {
    let t!: ReactTestRenderer;
    act(() => {
      t = create(element());
    });
    registry.frame(); // the first mapper run after the effects registered
    return t;
  };
  /** gorhom moves the sheet (outside the mapper run), then one frame of mappers runs. */
  const frame = (position: number, anim: Anim, gesture: number = GESTURE.UNDETERMINED) => {
    sheet.animatedPosition.set(position);
    sheet.animatedAnimationState.set(anim);
    sheet.animatedContentGestureState.set(gesture);
    registry.frame();
  };
  const reset = (position: number, anim: Anim) => {
    sheet.animatedPosition.set(position);
    sheet.animatedAnimationState.set(anim);
    sheet.animatedContentGestureState.set(GESTURE.UNDETERMINED);
    sheet.animatedHandleGestureState.set(GESTURE.UNDETERMINED);
  };
  /** On every frame the bar's bottom (height + translateY) is the visible edge. */
  const expectOnEdge = (t: ReactTestRenderer, position: number) => {
    const { height, translateY } = read(t);
    expect({ position, edge: height! + translateY! }).toEqual({ position, edge: visibleAt(position) });
  };

  test('open, settle, drag down, snap down, close: the bar is on the edge in the same frame', () => {
    reset(800, running(100, 0));
    const t = mount();
    expectOnEdge(t, 800);
    for (const p of [760, 650, 450, 250, 120, 100]) {
      frame(p, running(100, 0));
      expectOnEdge(t, p);
      expect(read(t).height).toBe(640); // laid out once, at the target
    }
    frame(100, stopped);
    expect(read(t)).toEqual({ height: 640, translateY: 0 });
    for (const p of [130, 180, 220]) {
      frame(p, stopped, GESTURE.ACTIVE);
      expectOnEdge(t, p);
      expect(read(t).height).toBe(640);
    }
    // Released toward a lower detent, then settled there: the one layout of
    // the move and the bar's transform land in the same frame.
    for (const p of [250, 290, 300]) {
      frame(p, running(300, 0), GESTURE.END);
      expectOnEdge(t, p);
    }
    frame(300, stopped);
    expect(read(t)).toEqual({ height: 440, translateY: 0 });
    for (const p of [400, 600, 800]) {
      frame(p, running(800, -1));
      expectOnEdge(t, p);
    }
    act(() => t.unmount());
  });

  test('keyboard up and down: the bar is on the edge in the same frame', () => {
    reset(100, stopped);
    const t = mount();
    expect(read(t)).toEqual({ height: 640, translateY: 0 });
    for (const p of [60, -20, -100]) {
      frame(p, running(-100, 1));
      expectOnEdge(t, p);
    }
    frame(-100, stopped);
    expect(read(t)).toEqual({ height: 840, translateY: 0 });
    for (const p of [-40, 50, 100]) {
      frame(p, running(100, 1));
      expectOnEdge(t, p);
    }
    frame(100, stopped);
    expect(read(t)).toEqual({ height: 640, translateY: 0 });
    act(() => t.unmount());
  });

  test('drag up past the laid-out height: grows in the same frame, no band under the list', () => {
    reset(160, stopped);
    const t = mount();
    expect(read(t)).toEqual({ height: 580, translateY: 0 });
    for (const p of [140, 100, 60]) {
      frame(p, stopped, GESTURE.ACTIVE);
      expect(read(t)).toEqual({ height: visibleAt(p), translateY: 0 });
    }
    act(() => t.unmount());
  });

  test('a handle drag counts as a gesture too', () => {
    reset(100, stopped);
    const t = mount();
    sheet.animatedHandleGestureState.set(GESTURE.BEGAN);
    frame(200, stopped);
    expect(read(t)).toEqual({ height: 640, translateY: -100 });
    sheet.animatedHandleGestureState.set(GESTURE.END);
    frame(200, stopped);
    expect(read(t)).toEqual({ height: 540, translateY: 0 });
    act(() => t.unmount());
  });

  test('settles: a frame with no sheet change changes nothing', () => {
    reset(100, running(100, 0));
    const t = mount();
    frame(100, stopped);
    const settled = read(t);
    registry.frame();
    registry.frame();
    expect(read(t)).toEqual(settled);
    act(() => t.unmount());
  });

  test('keeps the caller style', () => {
    reset(100, stopped);
    const t = mount();
    const style = t.root.findAllByType('animated-view' as never)[0].props.style as unknown[];
    expect(style[0]).toEqual({ paddingTop: 4 });
    act(() => t.unmount());
  });
});
