/**
 * Nav contract: a control whose destination is known at render time must be an
 * anchor, not a button that calls `router.push`.
 *
 * Why this is a correctness rule and not a style preference — in Next 16.3,
 * `node_modules/next/dist/client/components/router-reducer/fetch-server-response.js`
 * turns a client navigation into a FULL DOCUMENT LOAD whenever the RSC fetch it
 * runs at click time comes back wrong:
 *   :148  non-`text/x-component`, non-2xx, or empty body  (auth bounce, 401, 5xx)
 *   :177  the server build id differs from the client's   (any deploy)
 *   :181  the payload is a redirect
 *   ~:205 the fetch rejects                                (network blip)
 * A prefetched `<Link>` already holds the payload in the segment cache, so the
 * click never runs that fetch and none of the four can fire. A `<button>` +
 * `router.push` runs it cold on every single click, so it is exposed to all
 * four — which is why menu items, and only menu items, "sometimes hard refresh".
 *
 * The rule fires when a `router.push`/`router.replace` with a render-time-static
 * internal href sits in a click handler. It does NOT fire when the destination
 * cannot be known before the click (an id returned by a POST, a cmdk row
 * activated by keyboard, a Radix `Select` value). For those, prefetch the
 * destination as soon as it is knowable and annotate the line:
 *
 *   // nav-contract: prefetch-only — id comes back from the create POST
 *
 * The comment is required so every exemption states its reason.
 */

const HANDLER_ATTRS = new Set(['onClick', 'onSelect', 'onPress', 'onMouseDown']);
const ESCAPE = 'nav-contract:';

/** `/projects/x`, `` `/projects/${id}` `` — an internal, render-time-static href. */
function staticInternalHref(node) {
  if (!node) return false;
  if (node.type === 'Literal') return typeof node.value === 'string' && node.value.startsWith('/');
  if (node.type === 'TemplateLiteral') {
    const head = node.quasis[0];
    if (!head || !head.value.raw.startsWith('/')) return false;
    // Only identifiers / property reads. A call expression means the value is
    // computed at click time and may not exist during render.
    return node.expressions.every(
      (e) => e.type === 'Identifier' || e.type === 'MemberExpression',
    );
  }
  return false;
}

function isRouterNav(node) {
  const callee = node.callee;
  if (!callee || callee.type !== 'MemberExpression') return false;
  if (callee.property.type !== 'Identifier') return false;
  if (callee.property.name !== 'push' && callee.property.name !== 'replace') return false;
  const obj = callee.object;
  return obj.type === 'Identifier' && /router$/i.test(obj.name);
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Nav controls with a render-time-static internal destination must render an anchor (<Link>), not router.push in a click handler.',
    },
    schema: [],
    messages: {
      staticPush:
        "This control's destination '{{href}}' is known at render time, so it must be a <Link> (use `asChild` on the Button/MenuItem). A button + router.push runs the RSC fetch cold on every click, which is what turns a menu click into a full page reload. If the href genuinely is not knowable until the click, prefetch it and annotate the line with `// nav-contract: prefetch-only — <reason>`.",
    },
  },
  create(context) {
    const source = context.sourceCode ?? context.getSourceCode();
    /** Handler identifiers referenced by an onClick/onSelect JSX attribute. */
    const handlerNames = new Set();
    /** Candidate violations, resolved at Program:exit once handlerNames is complete. */
    const candidates = [];

    function exempted(node) {
      const before = source.getCommentsBefore(node);
      if (before.some((c) => c.value.includes(ESCAPE))) return true;
      const line = node.loc.start.line;
      return source
        .getAllComments()
        .some((c) => c.loc.start.line === line && c.value.includes(ESCAPE));
    }

    /** The nearest enclosing function, and the name it is bound to, if any. */
    function enclosingBinding(node) {
      let fn = null;
      let cur = node.parent;
      while (cur) {
        if (
          cur.type === 'ArrowFunctionExpression' ||
          cur.type === 'FunctionExpression' ||
          cur.type === 'FunctionDeclaration'
        ) {
          fn = fn ?? cur;
        }
        if (cur.type === 'JSXAttribute') {
          return { inJsxAttr: cur.name.name, name: null };
        }
        if (cur.type === 'VariableDeclarator' && cur.id.type === 'Identifier') {
          return { inJsxAttr: null, name: cur.id.name };
        }
        if (cur.type === 'FunctionDeclaration' && cur.id) {
          return { inJsxAttr: null, name: cur.id.name };
        }
        cur = cur.parent;
      }
      return { inJsxAttr: null, name: null };
    }

    return {
      JSXAttribute(node) {
        if (!HANDLER_ATTRS.has(node.name.name)) return;
        const v = node.value;
        if (!v || v.type !== 'JSXExpressionContainer') return;
        const e = v.expression;
        if (e.type === 'Identifier') handlerNames.add(e.name);
      },
      CallExpression(node) {
        if (!isRouterNav(node)) return;
        const arg = node.arguments[0];
        if (!staticInternalHref(arg)) return;
        if (exempted(node)) return;
        const { inJsxAttr, name } = enclosingBinding(node);
        const href =
          arg.type === 'Literal' ? arg.value : source.getText(arg).replace(/\s+/g, ' ').slice(0, 60);
        if (inJsxAttr && HANDLER_ATTRS.has(inJsxAttr)) {
          candidates.push({ node, href, name: null });
        } else if (name) {
          candidates.push({ node, href, name });
        }
      },
      'Program:exit'() {
        for (const c of candidates) {
          if (c.name === null || handlerNames.has(c.name)) {
            context.report({ node: c.node, messageId: 'staticPush', data: { href: c.href } });
          }
        }
      },
    };
  },
};

export default { rules: { 'no-router-push-for-static-href': rule } };
