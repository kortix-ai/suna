import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ArcSvg, LEFT_ARC, RIGHT_ARC } from './animated-bg';

const TONES = ['light', 'medium', 'dark'] as const;

// Characterization: the exact server markup of both arcs per tone. The snapshot
// was recorded against the two hand-copied components before they merged into
// ArcSvg. It is the behavior contract the merge must hold byte for byte.
describe('animated-bg left arc', () => {
  for (const tone of TONES) {
    it(`renders the ${tone} tone`, () => {
      const markup = renderToStaticMarkup(
        <ArcSvg cfg={LEFT_ARC} size={400} tone={tone} opacity={0.1} blurAmount={19} />,
      );

      expect(markup).toMatchSnapshot();
    });
  }
});

describe('animated-bg right arc', () => {
  for (const tone of TONES) {
    it(`renders the ${tone} tone`, () => {
      const markup = renderToStaticMarkup(
        <ArcSvg cfg={RIGHT_ARC} size={620} tone={tone} opacity={0.23} blurAmount={1} />,
      );

      expect(markup).toMatchSnapshot();
    });
  }
});
