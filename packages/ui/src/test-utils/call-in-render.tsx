import { renderToStaticMarkup } from 'react-dom/server';

import { IntlTestProvider } from './intl';

/**
 * Calls a component as a plain function inside a real render, so its hooks
 * (`useTranslations`, context reads) have a dispatcher and the bundled English
 * catalog. Returns the element tree the component built.
 */
export function callInRender<T>(fn: () => T): T {
  let out: T | undefined;
  function Probe() {
    out = fn();
    return null;
  }
  renderToStaticMarkup(
    <IntlTestProvider>
      <Probe />
    </IntlTestProvider>,
  );
  return out as T;
}
