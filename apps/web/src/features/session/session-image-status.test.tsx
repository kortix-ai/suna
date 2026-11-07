import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import en from '../../../translations/en.json';
import {
  SessionImageBanner,
  SessionImageStatus,
  type SessionImageStep,
  formatImageElapsed,
} from './session-image-status';

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
      {node}
    </NextIntlClientProvider>,
  );
}

const LINES: Record<SessionImageStep['state'], string> = {
  resolving: 'Choosing the image for this session.',
  serving_last_ready: 'Starting from the last ready image. The new one builds in the background.',
  waiting_for_build:
    'The first image for this workspace is building. The session starts when it is ready.',
  building: 'Building the first image for this workspace. This happens once and takes a few minutes.',
  copying_to_region: 'Copying the image to this session&#x27;s region.',
  waiting_for_provider: 'The image is finishing. The session starts when it is ready.',
};

function stepAgo(state: SessionImageStep['state'], seconds: number, image: string | null) {
  return { state, image, since: new Date(Date.now() - seconds * 1_000).toISOString() };
}

describe('the session start screen names the sandbox image step', () => {
  for (const [state, line] of Object.entries(LINES) as [SessionImageStep['state'], string][]) {
    test(`${state}: headline, its own line, and the time since the step began`, () => {
      const html = render(<SessionImageStatus step={stepAgo(state, 72, 'tpl-img-v3')} />);
      expect(html).toContain('Preparing the sandbox image');
      expect(html).toContain(line);
      expect(html).toContain(`data-image-state="${state}"`);
      expect(html).toMatch(/data-testid="session-image-elapsed"[^>]*>1:1[23]</);
      expect(html).toContain('tpl-img-v3');
      // No other state's line leaks in.
      for (const [other, otherLine] of Object.entries(LINES)) {
        if (other !== state) expect(html).not.toContain(otherLine);
      }
    });
  }

  test('without an image name, no name row renders', () => {
    const html = render(<SessionImageStatus step={stepAgo('resolving', 3, null)} />);
    expect(html).not.toContain('font-mono');
    expect(html).toContain('0:0');
  });

  test('the banner carries the same words, pinned above the surface', () => {
    const html = render(<SessionImageBanner step={stepAgo('building', 5, null)} />);
    expect(html).toContain('data-session-image-banner');
    expect(html).toContain('Preparing the sandbox image');
    expect(html).toContain(LINES.building);
  });

  test('every locale has the headline and all six lines', async () => {
    const locales = ['de', 'en', 'es', 'fr', 'it', 'ja', 'pt', 'sr', 'zh'];
    for (const locale of locales) {
      const catalog = (await import(`../../../translations/${locale}.json`)).default as {
        sessionPage: { image: { title: string; states: Record<string, string> } };
      };
      expect(catalog.sessionPage.image.title.length).toBeGreaterThan(0);
      expect(Object.keys(catalog.sessionPage.image.states).sort()).toEqual(
        Object.keys(LINES).sort(),
      );
    }
  });
});

describe('formatImageElapsed', () => {
  const since = '2026-11-02T10:00:00.000Z';
  const at = (s: number) => Date.parse(since) + s * 1_000;
  test('m:ss, minutes unbounded', () => {
    expect(formatImageElapsed(since, at(0))).toBe('0:00');
    expect(formatImageElapsed(since, at(9))).toBe('0:09');
    expect(formatImageElapsed(since, at(72))).toBe('1:12');
    expect(formatImageElapsed(since, at(3_725))).toBe('62:05');
  });
  test('a server clock ahead of this one, or an unreadable since, reads 0:00', () => {
    expect(formatImageElapsed(since, at(-30))).toBe('0:00');
    expect(formatImageElapsed('not a date', at(30))).toBe('0:00');
  });
});
