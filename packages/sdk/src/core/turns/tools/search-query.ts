/**
 * A search query → the words a reader sees.
 *
 * Models write queries in engine syntax: `site:daytona.io Daytona sandboxes`,
 * `filetype:pdf annual report`, `pricing -site:pinterest.com`. That syntax is
 * an instruction to a search engine, not a description of what was looked for —
 * and every row that renders a query renders it to someone who never typed it.
 * `site:daytona.io Daytona sandboxes` on an activity row reads as a bug.
 *
 * So operators are read, then removed. `site:` survives as English — it is the
 * one operator naming part of the SUBJECT ("on daytona.io") rather than the
 * machinery. The rest carry nothing a reader can act on: `filetype:pdf` does not
 * change what was searched for, it changes what the engine was allowed to
 * return.
 *
 * Two rules keep this from eating real text:
 *
 *   1. Operators are an ALLOWLIST, never a `\w+:` pattern. A query holding
 *      `https://example.com` matches `https:` under a pattern and loses the URL
 *      it was about — the exact class of bug this module exists to fix.
 *   2. The result is never empty. A query that is nothing but operators falls
 *      back to the sites it scoped to, and failing that to the original text.
 *      An empty row hides more than an ugly one.
 *
 * No React import — every rule here is unit-tested.
 */

/**
 * Operators recognised by the major engines. `site` is handled separately (see
 * the module comment); the rest are stripped outright.
 *
 * Anything not on this list is left alone, which is the point: an unknown
 * `foo:bar` is far more likely to be real text than a search operator.
 */
const OPERATORS = [
  'site',
  'filetype',
  'ext',
  'inurl',
  'allinurl',
  'intitle',
  'allintitle',
  'intext',
  'allintext',
  'inanchor',
  'inbody',
  'before',
  'after',
  'daterange',
  'related',
  'cache',
  'define',
  'link',
  'source',
  'lang',
  'loc',
  'location',
  'imagesize',
] as const;

/**
 * `name:value`, with the value optionally quoted so `intitle:"annual report"`
 * is consumed whole rather than leaving `report"` behind. A leading `-` or `+`
 * is captured, not skipped: the sign is what separates "search this site" from
 * "search everything except this site".
 *
 * Built fresh per call rather than hoisted — a module-level `/g` regex carries
 * `lastIndex` between calls, so a shared one would start mid-string on every
 * second query and silently leave operators in.
 */
function operatorPattern(): RegExp {
  return new RegExp(`(^|\\s)([-+]?)(${OPERATORS.join('|')}):("[^"]*"|\\S+)`, 'gi');
}

/** A term the query explicitly excluded, e.g. `-pinterest` or `-"stock photo"`. */
function negatedTermPattern(): RegExp {
  return /(^|\s)-(?:"[^"]*"|\S+)/g;
}

/** Bare boolean glue. Uppercase only — "or" mid-sentence is a word. */
function booleanPattern(): RegExp {
  return /(^|\s)(?:OR|AND)(?=\s|$)/g;
}

function stripQuotes(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/**
 * A `site:` value → the host a reader recognises.
 *
 * Models write the scope inconsistently — `site:daytona.io`,
 * `site:https://daytona.io`, `site:www.daytona.io/docs`. All three mean the
 * same site, and all three should read the same way on the row.
 */
function hostOf(value: string): string {
  return stripQuotes(value)
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .trim();
}

/** `[a]` → `a`; `[a, b]` → `a or b`; `[a, b, c]` → `a, b or c`. */
function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

export function humanizeSearchQuery(query: string | undefined | null): string {
  const raw = typeof query === 'string' ? query.trim() : '';
  if (!raw) return '';

  const scopes: string[] = [];

  let rest = raw.replace(
    operatorPattern(),
    (_match, lead: string, sign: string, name: string, value: string) => {
      // A negated scope (`-site:pinterest.com`) narrows by exclusion. The row has
      // no room to explain "everything except", and a bare "on pinterest.com"
      // would state the opposite of what actually ran — so it is dropped, not
      // reworded.
      if (!sign && name.toLowerCase() === 'site') {
        const host = hostOf(value);
        if (host && !scopes.includes(host)) scopes.push(host);
      }
      // Return the separator, not '': without it `a site:x b` fuses into `a b`
      // with no space, and consecutive operators run their neighbours together.
      return lead;
    },
  );

  rest = rest
    .replace(negatedTermPattern(), '$1')
    .replace(booleanPattern(), '$1')
    // Grouping parens are engine syntax too, and removing their contents'
    // operators routinely leaves them empty.
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!rest) {
    // Nothing but operators. The sites are the only thing left that names what
    // was looked at; with no sites either, the original beats a blank row.
    return scopes.length > 0 ? listPhrase(scopes) : raw;
  }

  return scopes.length > 0 ? `${rest} on ${listPhrase(scopes)}` : rest;
}
