/**
 * SiteLink's one decision: an href this origin serves as a static file
 * (`/docs`, the Blume Astro build — see `lib/navigation/static-site-path.ts`)
 * renders a plain `<a>` that performs a document load. A `next/link` cannot
 * soft-navigate into a static file: the viewport prefetch sends `RSC: 1`,
 * which the static file cannot answer (prod logged 404s for `/docs*`), and on
 * click the soft navigation fails before falling back to the same document
 * load. The plain anchor does that document load directly.
 *
 * Every navbar drawer row renders through this component, so this also pins
 * the mobile menu's full reload on Documentation as deliberate
 * (KRTX-1592): a client-side navigation into `/docs` does not exist until the
 * docs site becomes an App Router route.
 */
import { expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type MockLinkProps = { children?: ReactNode } & Record<string, unknown>;

// Router-only props that the mock must not render as DOM attributes.
const ROUTER_ONLY_PROPS = ['prefetch', 'replace', 'scroll', 'shallow', 'onNavigate', 'legacyBehavior'];

// Every soft link's props, so tests can assert the router-only props survive
// into `next/link` even though React does not serialize booleans to markup.
const softLinkProps: MockLinkProps[] = [];

mock.module('next/link', () => ({
  default: function MockNextLink({ children, ...props }: MockLinkProps) {
    softLinkProps.push(props);
    const anchorProps = Object.fromEntries(
      Object.entries(props).filter(([key]) => !ROUTER_ONLY_PROPS.includes(key)),
    );
    return (
      <a data-next-link="true" {...anchorProps}>
        {children}
      </a>
    );
  },
}));

const { default: SiteLink } = await import('./site-link');

test('a static path renders a plain anchor: no soft link, no router-only props', () => {
  const softLinkCalls = softLinkProps.length;
  for (const href of ['/docs', '/docs/sdk', '/docs/project/secrets#verify', '/sitemap.xml']) {
    const html = renderToStaticMarkup(
      <SiteLink href={href} prefetch replace className="row">
        Docs
      </SiteLink>,
    );
    expect(html.startsWith('<a ')).toBe(true);
    expect(html).not.toContain('data-next-link');
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain('class="row"');
    // Router-only props are dropped, so no 404 prefetch and no failed soft nav.
    expect(html).not.toContain('prefetch');
    expect(html).not.toContain('replace');
  }
  expect(softLinkProps.length).toBe(softLinkCalls);
});

test('an app path renders through next/link, including the /docsx look-alike', () => {
  const href = '/pricing';
  renderToStaticMarkup(
    <SiteLink href={href} prefetch className="row">
      Pricing
    </SiteLink>,
  );
  const softProps = softLinkProps[softLinkProps.length - 1];
  // Router-only props belong to the soft link that can honor them.
  expect(softProps?.href).toBe(href);
  expect(softProps?.prefetch).toBe(true);
  expect(softProps?.className).toBe('row');
  // The static-path boundary is exact-prefix: `/docsx` is a Next route that
  // merely shares the `/docs` prefix, so it must stay a soft link.
  renderToStaticMarkup(
    <SiteLink href="/docsx" prefetch replace>
      Docs look-alike
    </SiteLink>,
  );
  const lookalike = softLinkProps[softLinkProps.length - 1];
  expect(lookalike?.href).toBe('/docsx');
  expect(lookalike?.prefetch).toBe(true);
  expect(lookalike?.replace).toBe(true);
});
