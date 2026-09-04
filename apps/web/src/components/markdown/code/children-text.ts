import React from 'react';

/**
 * The literal text a markdown `code` node carries.
 *
 * The parser hands `code` a plain string, so both code renderers used to read
 * it as `String(children)`. That is only true until something in the render
 * path replaces the string with an element: `wrapChildrenWithPaths` did
 * exactly that for any fence whose body contained a file path, and
 * `String(<Fragment/>)` is the string `[object Object]` — which is what the
 * highlighter then drew, and what the copy button then copied.
 *
 * Reading the text out of the tree instead of stringifying the top node makes
 * the code text independent of whatever wraps it.
 */
export function childrenToText(children: React.ReactNode): string {
  if (children === null || children === undefined || typeof children === 'boolean') return '';
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(childrenToText).join('');
  if (React.isValidElement(children)) {
    const props = children.props as { children?: React.ReactNode } | undefined;
    return childrenToText(props?.children);
  }
  return '';
}
