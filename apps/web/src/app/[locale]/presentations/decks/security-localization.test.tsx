import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import messages from '../../../../../translations/de.json';
import { useSlides } from './security';

function BuiltDeck() {
  return (
    <>
      {useSlides().flatMap((slide) =>
        Array.from({ length: (slide.steps ?? 0) + 1 }, (_, step) => (
          <div key={`${slide.id}:${step}`}>
            {typeof slide.node === 'function' ? slide.node(step) : slide.node}
          </div>
        )),
      )}
    </>
  );
}

test('German security deck translates captions at every build step', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="de" timeZone="UTC" messages={messages}>
      <BuiltDeck />
    </NextIntlClientProvider>,
  );
  expect(html).not.toContain('A project is a repo.');
  expect(html).not.toContain('Session work reaches main through a change request.');
  expect(html).toContain('Ein Projekt');
  for (const [key, caption] of Object.entries(messages.hardcodedUi.i18nComplete)) {
    if (
      [
        'text1eddfe2fbb7a',
        'text6a51a65a11f4',
        'textdb3871e22b38',
        'textc610d5d19d2b',
        'text08cadd4156a5',
        'textc19146bd7bd6',
        'textafeac15c27a6',
        'text5b70d52b009e',
        'textcf072fa71675',
        'text0913fabeeba4',
        'text4c6aaca6d645',
        'text28ef515dd5b9',
        'text8f0f0d2cd359',
        'text7a570559b1e0',
        'text66d3cd60b831',
        'text89faa819e995',
        'textd26b162f1b6a',
        'text8e97f02e6f34',
        'text94ddcfbb2f30',
        'textc7d878b8738e',
        'text6fb8ad227c23',
      ].includes(key)
    ) {
      expect(html).toContain(caption);
    }
  }
});

test('security deck preserves its complete rendered output', () => {
  expect(createHash('sha256').update(renderToStaticMarkup(
    <NextIntlClientProvider locale="de" timeZone="UTC" messages={messages}>
      <BuiltDeck />
    </NextIntlClientProvider>,
  )).digest('hex')).toMatchSnapshot();
});
