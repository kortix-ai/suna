import { test, expect } from '@playwright/test';
import { decodePng } from './decode-png';

// Measures the rendered slant angle of a glyph's stem from real pixels — NOT
// advance width. Synthetic oblique (a skew transform browsers layer on top of
// a real face when `font-style: italic` is requested but no italic face is
// registered) does not change advance widths, only the rendered ink, so a
// width-based assertion cannot see it. This is why the pre-existing italic
// coverage (descriptor-support.spec.ts's `elemItal` check) missed F1: it only
// ever compared widths.
//
// Technique: rasterize the glyph via the real page cascade (a live DOM
// element styled with the real CSS classes — not a hand-copied CSS snippet),
// screenshot just that element, decode the PNG with zero new dependencies
// (Node's built-in zlib, see decode-png.ts), then compute the per-row ink
// centroid and linear-regress centroid-x against row-y. The slope is the
// stem's horizontal shift per vertical pixel; atan(slope) is the slant angle.
function measureSlantDegrees(png: ReturnType<typeof decodePng>): number {
  const { width, height, data } = png;
  const rows: { y: number; cx: number }[] = [];
  for (let y = 0; y < height; y++) {
    let sum = 0;
    let weight = 0;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];
      const luminance = (r + g + b) / 3;
      const ink = a > 10 ? Math.max(0, 255 - luminance) : 0;
      if (ink > 40) {
        sum += x * ink;
        weight += ink;
      }
    }
    if (weight > 0) rows.push({ y, cx: sum / weight });
  }
  if (rows.length < 10) {
    throw new Error(`measureSlantDegrees: too few ink rows (${rows.length}) — glyph did not render`);
  }
  // Trim the top/bottom 30% of the ink span: italic lowercase strokes often
  // carry an entry serif or a tail flourish there, which would bias the
  // centroid away from the straight mid-stem run this needs to measure.
  const yMin = rows[0].y;
  const yMax = rows[rows.length - 1].y;
  const span = yMax - yMin;
  const lo = yMin + span * 0.3;
  const hi = yMax - span * 0.3;
  const trimmed = rows.filter((r) => r.y >= lo && r.y <= hi);

  const n = trimmed.length;
  const meanY = trimmed.reduce((s, r) => s + r.y, 0) / n;
  const meanX = trimmed.reduce((s, r) => s + r.cx, 0) / n;
  let num = 0;
  let den = 0;
  for (const r of trimmed) {
    num += (r.y - meanY) * (r.cx - meanX);
    den += (r.y - meanY) * (r.y - meanY);
  }
  const slope = num / den; // horizontal px shift per vertical px
  return (Math.atan(Math.abs(slope)) * 180) / Math.PI;
}

async function screenshotGlyph(
  page: import('@playwright/test').Page,
  className: string,
  text = 'l',
) {
  const handle = await page.evaluateHandle(
    ({ className, text }) => {
      const div = document.createElement('div');
      div.style.cssText =
        'position:fixed;top:0;left:0;background:white;width:300px;height:320px;' +
        'padding:40px;margin:0;z-index:9999;overflow:visible;';
      const span = document.createElement('span');
      // Use the real utility class(es) so the app's cascade is what gets
      // rasterized — not a hand-copied CSS rule.
      if (className) span.className = className;
      span.style.cssText = 'font-size:200px;line-height:1;color:black;white-space:pre;';
      span.textContent = text;
      div.appendChild(span);
      document.body.appendChild(div);
      return div;
    },
    { className, text },
  );
  const el = handle.asElement();
  if (!el) throw new Error('screenshotGlyph: element handle was not an Element');
  const buf = await el.screenshot();
  await handle.evaluate((div) => div.remove());
  return decodePng(buf);
}

test.describe('Roobert italic slant (F1 regression)', () => {
  test('.italic renders the real ~11° axis slant, not synthetic ~24° oblique-on-oblique', async ({
    page,
  }) => {
    await page.goto('/design-system', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);

    const roobertLoaded = await page.evaluate(() => document.fonts.check('200px Roobert'));
    expect(
      roobertLoaded,
      'Roobert did not load — the slant measurement below would be against a fallback face and prove nothing',
    ).toBe(true);

    const upright = measureSlantDegrees(await screenshotGlyph(page, ''));
    const italic = measureSlantDegrees(await screenshotGlyph(page, 'italic'));

    // Guard: an upright glyph must measure ~0°. If this fails, the harness
    // itself (screenshot/decode/regression) is broken and the italic number
    // below proves nothing.
    expect(upright, `upright 'l' should measure ~0°, got ${upright}°`).toBeLessThan(2);

    // The real guard. Shipped (buggy) value was 24.06° in Chromium/WebKit —
    // synthetic oblique stacked on top of the real 11.11° axis slant. Fixed
    // value is ~11°. The threshold sits well clear of both: >5 rules out
    // "italic axis accidentally disabled", <18 rules out "synthesis still
    // stacking on top of the real slant".
    expect(
      italic,
      `.italic measured ${italic}° — expected ~11° (real ital=11 axis only). ` +
        `~24° means font-synthesis-style is not suppressing synthetic oblique on top of the real axis slant.`,
    ).toBeGreaterThan(5);
    expect(
      italic,
      `.italic measured ${italic}° — expected ~11°, not the ~24° synthetic-oblique-stacked-on-real-axis value`,
    ).toBeLessThan(18);
  });
});

test.describe('Roobert axis escape (F2/F3 regression)', () => {
  // F2: `.font-sans` could not escape a `.font-mono`/`code`/`pre` ancestor —
  // only font-family changed, which is a no-op (one family, axis-driven).
  test('.font-sans is proportional inside a .font-mono ancestor', async ({ page }) => {
    await page.goto('/design-system', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);

    const result = await page.evaluate(() => {
      const measure = (text: string) => {
        const s = document.createElement('span');
        s.className = 'font-sans';
        s.style.cssText =
          'position:absolute;left:-9999px;display:inline-block;white-space:pre;font-size:32px';
        s.textContent = text;
        document.body.appendChild(s);
        const r = document.createRange();
        r.selectNodeContents(s);
        const width = Math.round(r.getBoundingClientRect().width * 100) / 100;
        s.remove();
        return width;
      };

      const outer = document.createElement('div');
      outer.className = 'font-mono';
      document.body.appendChild(outer);
      // Real regression shape from cli-demo.tsx / bash-tool.tsx: `.font-sans`
      // nested INSIDE a `.font-mono` container.
      const w = (() => {
        const s = document.createElement('span');
        s.className = 'font-sans';
        s.style.cssText =
          'position:absolute;left:-9999px;display:inline-block;white-space:pre;font-size:32px';
        s.textContent = 'WWWWWWWWWW';
        outer.appendChild(s);
        const r = document.createRange();
        r.selectNodeContents(s);
        const width = Math.round(r.getBoundingClientRect().width * 100) / 100;
        return width;
      })();
      const m = (() => {
        const s = document.createElement('span');
        s.className = 'font-sans';
        s.style.cssText =
          'position:absolute;left:-9999px;display:inline-block;white-space:pre;font-size:32px';
        s.textContent = 'mmmmmmmmmm';
        outer.appendChild(s);
        const r = document.createRange();
        r.selectNodeContents(s);
        const width = Math.round(r.getBoundingClientRect().width * 100) / 100;
        return width;
      })();
      outer.remove();

      const roobertLoaded = document.fonts.check('32px Roobert');
      return { w, m, roobertLoaded, plainSansWidth: measure('WWWWWWWWWW') };
    });

    expect(
      result.roobertLoaded,
      'Roobert did not load — the proportional assertion below would pass on the system fallback and prove nothing',
    ).toBe(true);

    // Shipped (buggy): W and m collapse to the same width (MONO=100 inherited
    // from the .font-mono ancestor, un-cancelled). Fixed: W is meaningfully
    // wider than m (proportional), matching the ungated .font-sans baseline.
    const diff = result.w - result.m;
    expect(
      diff,
      `.font-sans inside .font-mono must be proportional — got W=${result.w}px m=${result.m}px (diff ${diff}px)`,
    ).toBeGreaterThan(5);
  });

  // Real regression site: checkpoint-detail-dialog.tsx:502 puts `.font-sans`
  // directly on a <pre>, which is matched by the `pre` selector itself.
  test('<pre class="font-sans"> is proportional, not monospaced', async ({ page }) => {
    await page.goto('/design-system', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);

    const result = await page.evaluate(() => {
      const measure = (text: string) => {
        const el = document.createElement('pre');
        el.className = 'font-sans';
        el.style.cssText =
          'position:absolute;left:-9999px;display:inline-block;white-space:pre;font-size:32px;margin:0';
        el.textContent = text;
        document.body.appendChild(el);
        const r = document.createRange();
        r.selectNodeContents(el);
        const width = Math.round(r.getBoundingClientRect().width * 100) / 100;
        el.remove();
        return width;
      };
      return {
        w: measure('WWWWWWWWWW'),
        m: measure('mmmmmmmmmm'),
        roobertLoaded: document.fonts.check('32px Roobert'),
      };
    });

    expect(
      result.roobertLoaded,
      'Roobert did not load — the proportional assertion below would pass on the system fallback and prove nothing',
    ).toBe(true);

    const diff = result.w - result.m;
    expect(
      diff,
      `<pre class="font-sans"> must be proportional — got W=${result.w}px m=${result.m}px (diff ${diff}px)`,
    ).toBeGreaterThan(5);
  });

  // F3: `.not-italic` could not cancel an ancestor's `--rb-ital`, because
  // Tailwind's own utility only sets `font-style: normal`, and the real axis
  // position (`--rb-ital`, an inherited custom property) survives that.
  test('.not-italic renders upright inside a .italic ancestor', async ({ page }) => {
    await page.goto('/design-system', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);

    const roobertLoaded = await page.evaluate(() => document.fonts.check('200px Roobert'));
    expect(
      roobertLoaded,
      'Roobert did not load — the upright assertion below would prove nothing',
    ).toBe(true);

    const angle = measureSlantDegrees(
      await (async () => {
        const handle = await page.evaluateHandle(() => {
          const outer = document.createElement('div');
          outer.className = 'italic';
          outer.style.cssText =
            'position:fixed;top:0;left:0;background:white;width:300px;height:320px;' +
            'padding:40px;margin:0;z-index:9999;overflow:visible;';
          const inner = document.createElement('span');
          // Real regression shape from input.tsx: `italic` on a field paired
          // with `.not-italic` on a descendant that must stay upright.
          inner.className = 'not-italic';
          inner.style.cssText = 'font-size:200px;line-height:1;color:black;white-space:pre;';
          inner.textContent = 'l';
          outer.appendChild(inner);
          document.body.appendChild(outer);
          return outer;
        });
        const el = handle.asElement();
        if (!el) throw new Error('element handle was not an Element');
        const buf = await el.screenshot();
        await handle.evaluate((div) => div.remove());
        return decodePng(buf);
      })(),
    );

    // Shipped (buggy): ~11° (still slanted — `--rb-ital` inherited from the
    // `.italic` ancestor, `.not-italic`'s own `font-style: normal` cannot
    // override the axis). Fixed: ~0°.
    expect(angle, `.not-italic inside .italic measured ${angle}° — expected ~0° (upright)`).toBeLessThan(3);
  });
});
