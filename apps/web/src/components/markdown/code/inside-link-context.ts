'use client';

import { createContext, useContext } from 'react';

/**
 * True while rendering INSIDE a markdown/anchor link.
 *
 * `ClickableInlineCode` reads it to avoid emitting a second `<a>` when a link's
 * text is itself a URL — e.g. the model writes `` [`http://localhost:3000/`](http://localhost:3000/) ``.
 * The markdown link renderer already wraps that in an `<a>`, and a nested `<a>`
 * is invalid HTML that throws a React hydration error ("`<a> cannot be a
 * descendant of <a>`"). Inside a link the inline code renders as styled `<code>`;
 * the surrounding anchor already carries the click.
 *
 * Providers: every markdown `a:` renderer (`unified-markdown`, `doc-markdown`,
 * `docs-mdx-components`) wraps its children in `InsideLinkContext.Provider value={true}`.
 */
export const InsideLinkContext = createContext(false);

export const useInsideLink = (): boolean => useContext(InsideLinkContext);
