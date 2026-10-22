import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from 'next-intl';
import messages from '../../../../translations/en.json';
import { LAYERS, getLocalizedHowItWorksContent } from './how-it-works-content';

const motion = await import('motion/react');
let reduced = true;
mock.module('motion/react', () => ({ ...motion, useReducedMotion: () => reduced }));
const ui = await import('@kortix/ui');
let desktop = false;
mock.module('@kortix/ui', () => ({ ...ui, useMediaQuery: () => desktop }));
const { HowItWorks } = await import('./how-it-works');
const { StepHarness } = await import('./step/step-harness');
const ids = ['source', 'context', 'models', 'harness', 'computer', 'control-plane'];

test('source and localized layers retain six ordered IDs and ordinals', () => {
  const t = createTranslator({ locale: 'en', messages, namespace: 'hardcodedUi.i18nComplete' });
  for (const layers of [LAYERS, getLocalizedHowItWorksContent(t).LAYERS]) {
    expect(layers.map(layer => String(layer.id))).toEqual(ids);
    expect(layers.map(layer => layer.ordinal)).toEqual(['01', '02', '03', '04', '05', '06']);
  }
});

for (const [name, wide, reduce] of [['mobile', false, true], ['reduced desktop', true, true], ['desktop', true, false]] as const) {
  test(`${name} retains six ordered panels`, () => {
    desktop = wide;
    reduced = reduce;
    const html = renderToStaticMarkup(<HowItWorks />);
    expect([...html.matchAll(/data-stack-layer="([^"]+)"/g)].map(match => match[1])).toEqual(ids);
    expect(html).toMatchSnapshot();
  });
}

test('reduced-motion harness renders the translated answer', () => {
  reduced = true;
  const html = renderToStaticMarkup(<StepHarness />);
  const text = html.replace(/<[^>]*>/g, '');
  expect(text).toContain(messages.hardcodedUi.i18nComplete.text673a8d7538da);
});
