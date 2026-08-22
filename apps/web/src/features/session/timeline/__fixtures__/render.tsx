/**
 * Render a timeline subtree to static markup under the providers the app
 * root supplies, and normalize the one thing React does not keep stable
 * across component-tree shapes.
 *
 * `useId` derives its token from the position in the component tree, so two
 * trees that produce the same DOM through different component nesting get
 * different `:R…:` / `«R…»` tokens on the same `aria-controls` / `id`
 * attributes. Radix primitives below a turn (the meta popover, the answered
 * question disclosure, tooltips) use `useId`. The golden is a comparison of
 * the DOM the reader gets, so those tokens are replaced with a placeholder on
 * both sides; everything else — every tag, attribute, class and text node — is
 * compared byte for byte.
 */
import { TooltipProvider } from '@/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

export function renderWithProviders(element: React.ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <TooltipProvider>{element}</TooltipProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

/** Replace every `useId` token with `USEID`. See the module doc. */
export function normalizeMarkup(markup: string): string {
  return markup
    .replace(/«[^»]*»/g, 'USEID')
    .replace(/_R_[0-9a-z_]*_/g, 'USEID')
    .replace(/:[Rr][0-9a-z]*:/g, 'USEID');
}
