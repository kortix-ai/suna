import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { DotmSquare1 } from './dotm-square-1';
import { DotmSquare2 } from './dotm-square-2';
import { DotmSquare3 } from './dotm-square-3';
import { DotmSquare4 } from './dotm-square-4';
import { DotmSquare5 } from './dotm-square-5';
import { DotmSquare6 } from './dotm-square-6';
import { DotmSquare7 } from './dotm-square-7';
import { DotmSquare8 } from './dotm-square-8';
import { DotmSquare9 } from './dotm-square-9';
import { DotmSquare10 } from './dotm-square-10';
import { DotmSquare11 } from './dotm-square-11';
import { DotmSquare12 } from './dotm-square-12';
import { DotmSquare13 } from './dotm-square-13';
import { DotmSquare14 } from './dotm-square-14';
import { DotmSquare15 } from './dotm-square-15';
import { DotmSquare16 } from './dotm-square-16';
import { DotmSquare17 } from './dotm-square-17';
import { DotmSquare18 } from './dotm-square-18';
import { DotmSquare19 } from './dotm-square-19';
import { DotmSquare20 } from './dotm-square-20';

describe('square matrix rendering', () => {
  const variants = [
    DotmSquare1, DotmSquare2, DotmSquare3, DotmSquare4, DotmSquare5,
    DotmSquare6, DotmSquare7, DotmSquare8, DotmSquare9, DotmSquare10,
    DotmSquare11, DotmSquare12, DotmSquare13, DotmSquare14, DotmSquare15,
    DotmSquare16, DotmSquare17, DotmSquare18, DotmSquare19, DotmSquare20,
  ];
  for (const [index, Component] of variants.entries()) {
    test(`DotmSquare${index + 1}`, () => {
      const html = renderToStaticMarkup(
        <Component animated={false} pattern="outline" size={22} dotSize={3} ariaLabel="loading" />,
      );
      expect(html).toContain('aria-label="loading"');
      expect(html).toContain('width:22px');
      expect(html).toContain('width:3px');
      expect((html.match(/class="dmx-dot/g) ?? []).length).toBe(25);
      expect((html.match(/dmx-inactive/g) ?? []).length).toBeGreaterThan(0);
      expect(Component.displayName).toBe(`DotmSquare${index + 1}`);
    });
  }
});
