import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import * as connectors from './component/section-primitives';
import * as solutions from './component/section-primitives';

for (const [name, { Section, Eyebrow }] of Object.entries({ connectors, solutions })) {
  for (const className of [undefined, 'py-8 synthetic']) {
    test(`${name} Section and Eyebrow preserve markup (${className})`, () => {
      expect(renderToStaticMarkup(<Section id="synthetic" className={className}>Body</Section>)).toMatchSnapshot();
      expect(renderToStaticMarkup(<Eyebrow className={className}>Label</Eyebrow>)).toMatchSnapshot();
    });
  }
}
