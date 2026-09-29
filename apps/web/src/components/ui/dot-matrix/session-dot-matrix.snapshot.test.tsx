import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { DOT_MATRIX_CATALOG } from './session-dot-matrix';

/**
 * Characterization pins for the server-rendered markup of every catalog
 * variant (KRTX-653 phase 1 safety net). These exist so the mechanical
 * dedupe of the 35 dotm 5x5 variant files (phases 2-3) can be reviewed
 * against today's exact output: any change to a variant's SSR markup
 * fails here.
 *
 * Each row pins one render: sha256:16 over the whole renderToStaticMarkup
 * output, plus a readable signature (span count, resolver-marked inactive
 * spans, distinct inline opacities) so a failure names what moved before
 * anyone re-renders by hand.
 *
 * Rows were generated at origin/main 41b2a206b by rendering every catalog
 * entry with no props ("def", the component's own default size) and with
 * size={14} ("s14", the busy-indicator size). SSR is deterministic: the
 * animation hooks never run on the server, so every render samples
 * cycle phase 0 / step 0 / phase 'loadingRipple'.
 *
 * The 3x3 family ignores `size` (DotMatrix3Base lays out from dotSize +
 * cellPadding), so its def and s14 rows share one digest. Circular and
 * square variants differ per size and are pinned separately.
 */

type MarkupPin = {
  /** sha256:16 of the full renderToStaticMarkup output. */
  digest: string;
  /** All dot spans SSR renders, in document order. */
  dots: number;
  /** Spans the resolver marks `dmx-inactive` (pattern-active but class-hidden). */
  inactive: number;
  /** Distinct inline `opacity:` values with multiplicities, e.g. `1x6,0.08x13`. */
  opacities: string;
};

type SizeKey = 'def' | 's14';

// [name, size, digest, dots, inactive, opacities]
const MARKUP_PINS: ReadonlyArray<[string, SizeKey, string, number, number, string]> = [
  ['dotm-3x3-2', 'def', 'bee373c6195e59b1', 9, 0, 'none'],
  ['dotm-3x3-2', 's14', 'bee373c6195e59b1', 9, 0, 'none'],
  ['dotm-3x3-3', 'def', '2585b680690bee60', 9, 0, 'none'],
  ['dotm-3x3-3', 's14', '2585b680690bee60', 9, 0, 'none'],
  ['dotm-3x3-4', 'def', 'ab73823fb37cd8e4', 9, 0, 'none'],
  ['dotm-3x3-4', 's14', 'ab73823fb37cd8e4', 9, 0, 'none'],
  ['dotm-3x3-5', 'def', '31d804b4b84927d5', 9, 0, 'none'],
  ['dotm-3x3-5', 's14', '31d804b4b84927d5', 9, 0, 'none'],
  ['dotm-3x3-6', 'def', '86105b44366abb3a', 9, 0, 'none'],
  ['dotm-3x3-6', 's14', '86105b44366abb3a', 9, 0, 'none'],
  ['dotm-3x3-7', 'def', '65a12b9270586dfd', 9, 0, 'none'],
  ['dotm-3x3-7', 's14', '65a12b9270586dfd', 9, 0, 'none'],
  ['dotm-3x3-8', 'def', '9578d2f7d7862632', 9, 0, 'none'],
  ['dotm-3x3-8', 's14', '9578d2f7d7862632', 9, 0, 'none'],
  ['dotm-3x3-9', 'def', 'f6670f46a3b93017', 9, 0, 'none'],
  ['dotm-3x3-9', 's14', 'f6670f46a3b93017', 9, 0, 'none'],
  ['dotm-3x3-10', 'def', '74baad0cd7253f15', 9, 0, 'none'],
  ['dotm-3x3-10', 's14', '74baad0cd7253f15', 9, 0, 'none'],
  ['dotm-3x3-12', 'def', '77dc5d9d049dbfed', 9, 0, 'none'],
  ['dotm-3x3-12', 's14', '77dc5d9d049dbfed', 9, 0, 'none'],
  ['dotm-3x3-13', 'def', 'd76821605582feb9', 9, 0, 'none'],
  ['dotm-3x3-13', 's14', 'd76821605582feb9', 9, 0, 'none'],
  ['dotm-3x3-15', 'def', 'f0983423052e9456', 9, 0, 'none'],
  ['dotm-3x3-15', 's14', 'f0983423052e9456', 9, 0, 'none'],
  ['dotm-3x3-16', 'def', '6c803487b472c067', 9, 0, '0.8800000000000001x3,0.07076923076923076x6'],
  ['dotm-3x3-16', 's14', '6c803487b472c067', 9, 0, '0.8800000000000001x3,0.07076923076923076x6'],
  ['dotm-3x3-18', 'def', '07e4cf39cd65543a', 9, 0, '0.07076923076923076x6,0.8800000000000001x3'],
  ['dotm-3x3-18', 's14', '07e4cf39cd65543a', 9, 0, '0.07076923076923076x6,0.8800000000000001x3'],
  ['dotm-3x3-19', 'def', '16fdb02651c9c0f2', 9, 0, '0.07076923076923076x5,0.8800000000000001x4'],
  ['dotm-3x3-19', 's14', '16fdb02651c9c0f2', 9, 0, '0.07076923076923076x5,0.8800000000000001x4'],
  ['dotm-3x3-20', 'def', '528ec383f8aaf59d', 9, 0, '0.8800000000000001x4,0.07076923076923076x5'],
  ['dotm-3x3-20', 's14', '528ec383f8aaf59d', 9, 0, '0.8800000000000001x4,0.07076923076923076x5'],
  ['dotm-3x3-21', 'def', '7802a7b77f78e6cc', 9, 0, '0.8800000000000001x4,0.07076923076923076x5'],
  ['dotm-3x3-21', 's14', '7802a7b77f78e6cc', 9, 0, '0.8800000000000001x4,0.07076923076923076x5'],
  ['dotm-circular-1', 'def', '63764463fe4631d7', 25, 4, '1x6,0.08x13,0.24x2'],
  ['dotm-circular-1', 's14', '950f6cc747dae8ff', 25, 4, '1x6,0.08x13,0.24x2'],
  ['dotm-circular-2', 'def', 'f1057e7414a98f0d', 25, 4, '0.08x8,0.18x1'],
  ['dotm-circular-2', 's14', '1c4d0ba7cc4950cd', 25, 4, '0.08x8,0.18x1'],
  [
    'dotm-circular-3',
    'def',
    'b2d4272ab69afcb6',
    25,
    4,
    '1x1,0.08x10,0.15839999999999999x1,0.78x1,0.2592x1,0.56x1,0.16x1,0.4032x1,0.36x1,0.5616x1,0.22x1,0.72x1',
  ],
  [
    'dotm-circular-3',
    's14',
    '9d07207edf826e65',
    25,
    4,
    '1x1,0.08x10,0.15839999999999999x1,0.78x1,0.2592x1,0.56x1,0.16x1,0.4032x1,0.36x1,0.5616x1,0.22x1,0.72x1',
  ],
  ['dotm-circular-4', 'def', '8bde50f6e94eac87', 25, 4, '0.22x9,0.08x5,0.36x4,0.62x1,0.96x2'],
  ['dotm-circular-4', 's14', 'b4efe8e4138fdf04', 25, 4, '0.22x9,0.08x5,0.36x4,0.62x1,0.96x2'],
  ['dotm-circular-5', 'def', 'b0e2c82b0611aa1e', 25, 4, '0.08x12,0.34x4,0.94x4,0.66x1'],
  ['dotm-circular-5', 's14', '5551339eda184d9d', 25, 4, '0.08x12,0.34x4,0.94x4,0.66x1'],
  ['dotm-circular-6', 'def', 'e0c3be7f8762306c', 25, 4, '0.08x8,0.34x7,0.96x3,0.62x3'],
  ['dotm-circular-6', 's14', 'e659f977ec7433d6', 25, 4, '0.08x8,0.34x7,0.96x3,0.62x3'],
  [
    'dotm-circular-7',
    'def',
    '0c1e88caadb6601f',
    25,
    4,
    '0.26711071225238914x1,0.38458773135227514x2,0.6724091691672314x1,0.6494362848400431x1,0.571447299884274x1,0.24624510976245334x2,0.26054094710352244x1,0.26558025349367576x1,0.2602731109135885x1,0.12193048932376677x1,0.92x1,0.6931304893237668x1,0.8314731109135886x1,0.6445349475989323x1,0.6553756804676536x1,0.1766125665201428x1,0.27048159073478667x1,0.2622093750112782x1,0.6773105064083422x1',
  ],
  [
    'dotm-circular-7',
    's14',
    'a4d8bb0b3667ac6e',
    25,
    4,
    '0.26711071225238914x1,0.38458773135227514x2,0.6724091691672314x1,0.6494362848400431x1,0.571447299884274x1,0.24624510976245334x2,0.26054094710352244x1,0.26558025349367576x1,0.2602731109135885x1,0.12193048932376677x1,0.92x1,0.6931304893237668x1,0.8314731109135886x1,0.6445349475989323x1,0.6553756804676536x1,0.1766125665201428x1,0.27048159073478667x1,0.2622093750112782x1,0.6773105064083422x1',
  ],
  ['dotm-circular-8', 'def', '6b7eda8e91b062db', 25, 4, '0.08x12,0.16x8,0.35x1'],
  ['dotm-circular-8', 's14', '692368078d98ee51', 25, 4, '0.08x12,0.16x8,0.35x1'],
  ['dotm-circular-9', 'def', '117dcbdbeabc8543', 25, 4, '0.07x16,0.28x2,0.24x1,0.62x1,0.96x1'],
  ['dotm-circular-9', 's14', '2088e7c27396d68e', 25, 4, '0.07x16,0.28x2,0.24x1,0.62x1,0.96x1'],
  ['dotm-circular-10', 'def', '983094bc7adde7a2', 25, 4, '0.48x6,0.2x4,0.06x7,0.94x4'],
  ['dotm-circular-10', 's14', '2e0561f07b3a2247', 25, 4, '0.48x6,0.2x4,0.06x7,0.94x4'],
  [
    'dotm-circular-11',
    'def',
    '8ec73bf98c627ae3',
    25,
    4,
    '0.07x12,0.95x5,0.46335191922614877x2,0.4257142857142857x1,0.3x1',
  ],
  [
    'dotm-circular-11',
    's14',
    '3d8ab3f75a593d48',
    25,
    4,
    '0.07x12,0.95x5,0.46335191922614877x2,0.4257142857142857x1,0.3x1',
  ],
  ['dotm-circular-12', 'def', '41d72c448c25678e', 25, 4, '0.06x13,0.3x5,0.62x1,0.96x2'],
  ['dotm-circular-12', 's14', '3fccd3b534dd00ea', 25, 4, '0.06x13,0.3x5,0.62x1,0.96x2'],
  ['dotm-circular-14', 'def', '914d6cccddc8a42c', 25, 4, '0.95x3,0.56x2,0.07x14,0.28x2'],
  ['dotm-circular-14', 's14', '14d837373ef83874', 25, 4, '0.95x3,0.56x2,0.07x14,0.28x2'],
  ['dotm-circular-15', 'def', '6fbb84e4cc4cccb1', 25, 4, '0.07x12,0.95x6,0.2x2,0.34x1'],
  ['dotm-circular-15', 's14', '0a9f69336f790bec', 25, 4, '0.07x12,0.95x6,0.2x2,0.34x1'],
  ['dotm-circular-17', 'def', '59c7be28f12f7b69', 25, 4, '0.24x4,0.34x9,0.07x4,0.95x4'],
  ['dotm-circular-17', 's14', 'e2ba59192d7f88c7', 25, 4, '0.24x4,0.34x9,0.07x4,0.95x4'],
  ['dotm-square-1', 'def', 'f6d6fc33b392e140', 25, 0, 'none'],
  ['dotm-square-1', 's14', '51c4589c1ef938ab', 25, 0, 'none'],
  [
    'dotm-square-2',
    'def',
    'fe71fcf9142276a2',
    25,
    0,
    '0.08x17,0.14x1,0.22x1,0.31x1,0.42x1,0.54x1,0.68x1,1x1,0.82x1',
  ],
  [
    'dotm-square-2',
    's14',
    '83b5f1468978c065',
    25,
    0,
    '0.08x17,0.14x1,0.22x1,0.31x1,0.42x1,0.54x1,0.68x1,1x1,0.82x1',
  ],
  ['dotm-square-3', 'def', '1b28ac2f72b450f7', 25, 0, 'none'],
  ['dotm-square-3', 's14', 'b068edfc514b2956', 25, 0, 'none'],
  ['dotm-square-4', 'def', 'c4e1c90ba3c8160b', 25, 1, 'none'],
  ['dotm-square-4', 's14', '3e0da79111912f14', 25, 1, 'none'],
  ['dotm-square-5', 'def', '2adbada6cdffd7de', 25, 0, 'none'],
  ['dotm-square-5', 's14', '1e46eddccd9266d0', 25, 0, 'none'],
  ['dotm-square-6', 'def', 'eb71a6fc47101ac3', 25, 0, 'none'],
  ['dotm-square-6', 's14', '75a6b5a97b8aafd2', 25, 0, 'none'],
  ['dotm-square-7', 'def', 'c7a7614b121d4d0b', 25, 0, '0.08x20,0.42x5'],
  ['dotm-square-7', 's14', '37a12fefa9952313', 25, 0, '0.08x20,0.42x5'],
  ['dotm-square-8', 'def', 'd677556527526da8', 25, 0, '0.08x25'],
  ['dotm-square-8', 's14', '7e0daad81d098b8b', 25, 0, '0.08x25'],
  ['dotm-square-9', 'def', 'f783e1aae3977236', 25, 0, '0.08x10,0.12x3'],
  ['dotm-square-9', 's14', 'e260b2662b9124a7', 25, 0, '0.08x10,0.12x3'],
  [
    'dotm-square-10',
    'def',
    'b4702ea97a2eae7b',
    25,
    0,
    '1x3,0.9810665086804374x1,0.9419444525557666x1,0.08x20',
  ],
  [
    'dotm-square-10',
    's14',
    '2a863c2db9f51ab3',
    25,
    0,
    '1x3,0.9810665086804374x1,0.9419444525557666x1,0.08x20',
  ],
  ['dotm-square-11', 'def', '08d2b53661d92cc7', 25, 0, 'none'],
  ['dotm-square-11', 's14', '789a53d629536af0', 25, 0, 'none'],
  ['dotm-square-12', 'def', '1e0d4294dd039fad', 25, 0, 'none'],
  ['dotm-square-12', 's14', 'e17de4b9818b4fe8', 25, 0, 'none'],
  ['dotm-square-13', 'def', '26d97e55a70504d3', 25, 0, '0.08x22,1x2,0.56x1'],
  ['dotm-square-13', 's14', 'bd8fc45423f00fb9', 25, 0, '0.08x22,1x2,0.56x1'],
  ['dotm-square-14', 'def', '61bedbeebbf454c8', 25, 0, '1x8,0.08x16,0.52x1'],
  ['dotm-square-14', 's14', '61bedbeebbf454c8', 25, 0, '1x8,0.08x16,0.52x1'],
  ['dotm-square-15', 'def', '6d813ece8878317b', 25, 0, '0.24x10,1x8,0.58x1,0.08x6'],
  ['dotm-square-15', 's14', 'b97bb2515f42e2b1', 25, 0, '0.24x10,1x8,0.58x1,0.08x6'],
  ['dotm-square-16', 'def', '5d034bc3d670ddf2', 25, 0, '0.08x6,0.24x12,1x7'],
  ['dotm-square-16', 's14', '668b7aaf4b23015f', 25, 0, '0.08x6,0.24x12,1x7'],
  ['dotm-square-17', 'def', '8b02a5b2bc318bf1', 25, 0, '0.08x12,0.24x8,1x5'],
  ['dotm-square-17', 's14', '31b588f0bb580aa7', 25, 0, '0.08x12,0.24x8,1x5'],
  ['dotm-square-18', 'def', '2ac96aab51b6e987', 25, 0, '0.08x10,1x5,0.94x10'],
  ['dotm-square-18', 's14', 'ad14f4e1100fb268', 25, 0, '0.08x10,1x5,0.94x10'],
  [
    'dotm-square-19',
    'def',
    'fc85ce40168c0852',
    25,
    0,
    '0.08001722484356018x2,0.08086359324667443x2,0.08321152892293866x1,0.08129533007440401x2,0.12623935695163035x2,0.24740087397576993x1,0.10596256312454783x2,0.3317780021506738x1,0.8827516298654349x1,0.33177800215067393x1,0.16670297879258517x2,0.44461282895055393x1,0.3328085226939512x1,0.444612828950554x1,0.10332451806553852x2,0.1677460209606527x2,0.10651882214491701x1',
  ],
  [
    'dotm-square-19',
    's14',
    '6659038af7ca0206',
    25,
    0,
    '0.08001722484356018x2,0.08086359324667443x2,0.08321152892293866x1,0.08129533007440401x2,0.12623935695163035x2,0.24740087397576993x1,0.10596256312454783x2,0.3317780021506738x1,0.8827516298654349x1,0.33177800215067393x1,0.16670297879258517x2,0.44461282895055393x1,0.3328085226939512x1,0.444612828950554x1,0.10332451806553852x2,0.1677460209606527x2,0.10651882214491701x1',
  ],
  [
    'dotm-square-20',
    'def',
    '607149f989cd129f',
    25,
    0,
    '1x1,0.08x13,0.82x1,0.52x1,0.14x1,0.64x1,0.55x1,0.22x1,0.46x1,0.3x2,0.18x1,0.38x1',
  ],
  [
    'dotm-square-20',
    's14',
    '38033bfa4a9a0d8e',
    25,
    0,
    '1x1,0.08x13,0.82x1,0.52x1,0.14x1,0.64x1,0.55x1,0.22x1,0.46x1,0.3x2,0.18x1,0.38x1',
  ],
];

const RENDER_SIZE: Record<SizeKey, number | undefined> = { def: undefined, s14: 14 };

function renderFor(name: string, sizeKey: SizeKey): string {
  const entry = DOT_MATRIX_CATALOG.find((candidate) => candidate.name === name);
  if (!entry) {
    throw new Error(`no catalog entry named ${name}`);
  }
  const size = RENDER_SIZE[sizeKey];
  return size == null
    ? renderToStaticMarkup(<entry.Component />)
    : renderToStaticMarkup(<entry.Component size={size} />);
}

function observedFor(html: string): MarkupPin {
  const dots = [...html.matchAll(/<span\b/g)].length;
  const inactive = [...html.matchAll(/class="dmx-dot dmx-inactive"/g)].length;
  const counts = new Map<string, number>();
  for (const match of html.matchAll(/opacity:([\d.]+)/g)) {
    counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
  }
  const opacities =
    [...counts.entries()].map(([value, count]) => `${value}x${count}`).join(',') || 'none';
  return {
    digest: createHash('sha256').update(html).digest('hex').slice(0, 16),
    dots,
    inactive,
    opacities,
  };
}

describe('catalog SSR markup pins', () => {
  test('every catalog variant has exactly one def and one s14 pin', () => {
    const pairs = MARKUP_PINS.map(([name, sizeKey]) => `${name}:${sizeKey}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    const names = MARKUP_PINS.map(([name]) => name);
    const catalogNames = DOT_MATRIX_CATALOG.map((entry) => entry.name);
    expect(new Set(names)).toEqual(new Set(catalogNames));
    for (const name of catalogNames) {
      expect(
        MARKUP_PINS.filter(([candidate]) => candidate === name)
          .map(([, sizeKey]) => sizeKey)
          .sort(),
      ).toEqual(['def', 's14']);
    }
  });

  test.each(MARKUP_PINS)(
    '%s (%s) server markup is pinned',
    (name, sizeKey, digest, dots, inactive, opacities) => {
      const html = renderFor(name, sizeKey);
      expect(observedFor(html)).toEqual({ digest, dots, inactive, opacities });
    },
  );
});
