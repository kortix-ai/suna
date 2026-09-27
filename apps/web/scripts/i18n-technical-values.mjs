import ts from 'typescript';

/**
 * Non-linguistic catalog values and bindings.
 *
 * The catalog extractor once pulled machine-read strings into the translation
 * catalogs: SVG transforms (`matrix(…)` became `drehen(…)` in German), iframe
 * sandbox tokens, file-input `accept` lists, Tailwind class lists, and email
 * addresses (Serbian transliterated them to Cyrillic). A translated value of
 * that kind breaks the product instead of localizing it.
 *
 * Two rules, both enforced by `audit-i18n.mjs`:
 * 1. A catalog value that is technical (see `technicalValueKind`) must be
 *    byte-identical to English in every locale.
 * 2. Source code never binds a non-linguistic attribute or style property
 *    (see `NON_LINGUISTIC_BINDING`) to a translation call. Those values live
 *    in code, where translators cannot reach them.
 */

const TRANSFORM_ARGS = String.raw`\((?:[-+\d.,\s]|e-?\d|px|deg|rad|turn|%|rem|em|\{\w+\})*\)`;
const TRANSFORM = new RegExp(
  String.raw`^\s*(?:(?:matrix|rotate|translate|scale|skew)(?:[XYZ]|3d)?\s*${TRANSFORM_ARGS}\s*)+$`,
);
const ENABLE_BACKGROUND = /^new(?: -?[\d.]+){4}$/;
const IFRAME_SANDBOX = /^allow-[a-z-]+(?: allow-[a-z-]+)*$/;
const ACCEPT_ITEM = String.raw`(?:[a-z*]+\/[a-z0-9*+.-]+|\.[a-z0-9]+)`;
const ACCEPT_LIST = new RegExp(String.raw`^${ACCEPT_ITEM}(?:\s*,\s*${ACCEPT_ITEM})*$`);
const EMAIL = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;
const URL_VALUE = /^(?:https?:\/\/|mailto:)\S+$/;

const UTILITY_PREFIXES = [
  'bg',
  'text',
  'border',
  'size',
  'min-w',
  'min-h',
  'max-w',
  'max-h',
  'w',
  'h',
  'm',
  'mt',
  'mr',
  'mb',
  'ml',
  'mx',
  'my',
  'p',
  'pt',
  'pr',
  'pb',
  'pl',
  'px',
  'py',
  'flex',
  'grid',
  'gap',
  'space-x',
  'space-y',
  'rounded',
  'shadow',
  'animate',
  'shrink',
  'grow',
  'basis',
  'items',
  'justify',
  'self',
  'from',
  'via',
  'to',
  'font',
  'leading',
  'tracking',
  'overflow',
  'select',
  'cursor',
  'opacity',
  'z',
  'inset',
  'top',
  'left',
  'right',
  'bottom',
  'ring',
  'outline',
  'transition',
  'duration',
  'ease',
  'col',
  'row',
  'order',
  'whitespace',
  'break',
  'decoration',
  'divide',
  'place',
  'object',
  'aspect',
  'backdrop',
  'blur',
  'fill',
  'stroke',
];
const STANDALONE_UTILITIES = new Set([
  'flex',
  'grid',
  'hidden',
  'block',
  'inline',
  'truncate',
  'underline',
  'italic',
  'uppercase',
  'lowercase',
  'absolute',
  'relative',
  'fixed',
  'sticky',
  'rounded',
  'shadow',
  'border',
  'grow',
  'shrink',
  'transition',
  'contents',
]);
const UTILITY = new RegExp(
  String.raw`^(?:[a-z0-9]+:)*!?-?(?:${UTILITY_PREFIXES.join('|')})-[\w./\[\]%#:-]+$`,
);

function isUtility(token) {
  const bare = token.replace(/^(?:[a-z0-9]+:)*!?/, '');
  return STANDALONE_UTILITIES.has(bare) || UTILITY.test(token);
}

function isClassList(value) {
  const tokens = value.trim().split(/\s+/);
  return (
    tokens.length >= 2 && tokens.some((token) => token.includes('-')) && tokens.every(isUtility)
  );
}

/** The kind of technical value `english` is, or null for translatable text. */
export function technicalValueKind(english) {
  if (typeof english !== 'string' || english.length === 0) return null;
  if (TRANSFORM.test(english)) return 'transform';
  if (ENABLE_BACKGROUND.test(english)) return 'enable-background';
  if (IFRAME_SANDBOX.test(english)) return 'iframe-sandbox';
  if (ACCEPT_LIST.test(english) && /[*,]|^\./.test(english)) return 'accept-list';
  if (EMAIL.test(english)) return 'email';
  if (URL_VALUE.test(english)) return 'url';
  if (isClassList(english)) return 'class-list';
  return null;
}

/**
 * Attribute and object-property names whose value is read by a machine, not a
 * person. Matches `gradientTransform`, `className`, `parentClass`, `bgColor`, …
 */
export const NON_LINGUISTIC_BINDING =
  /^(?:gradientTransform|transform|enableBackground|sandbox|accept|bgColor|iconColor|tint|d|viewBox|points|href|src|[A-Za-z]*[cC]lass(?:Name)?)$/;

function isTranslationCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const first = node.arguments[0];
  if (!first || !ts.isStringLiteralLike(first)) return false;
  let callee = node.expression;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ['raw', 'rich', 'markup'].includes(callee.name.text)
  ) {
    callee = callee.expression;
  }
  return ts.isIdentifier(callee) && /^t(?:[A-Z0-9]\w*)?$/.test(callee.text);
}

/** The attribute or property that receives the value of `node`, if any. */
function bindingName(node) {
  let cursor = node.parent;
  while (
    cursor &&
    (ts.isParenthesizedExpression(cursor) ||
      ts.isConditionalExpression(cursor) ||
      ts.isBinaryExpression(cursor) ||
      ts.isJsxExpression(cursor) ||
      ts.isTemplateSpan(cursor) ||
      ts.isTemplateExpression(cursor) ||
      ts.isAsExpression(cursor))
  ) {
    if (ts.isJsxExpression(cursor) && ts.isJsxAttribute(cursor.parent)) {
      return cursor.parent.name.getText();
    }
    cursor = cursor.parent;
  }
  if (cursor && ts.isPropertyAssignment(cursor)) {
    const name = cursor.name;
    return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
  }
  return null;
}

/**
 * Translation calls whose result feeds a non-linguistic attribute or property,
 * through any conditional, template, or parenthesized wrapper.
 */
export function nonLinguisticBindings(sourceText, fileName = 'source.tsx') {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const findings = [];
  const visit = (node) => {
    if (isTranslationCall(node)) {
      const name = bindingName(node);
      if (name && NON_LINGUISTIC_BINDING.test(name)) {
        findings.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          name,
          key: node.arguments[0].text,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}
