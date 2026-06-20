/**
 * Parsing for connector spec documents (OpenAPI, and any other JSON/YAML doc we
 * fetch from a URL or read from the repo). Kept dependency-free (only the `yaml`
 * parser) so it's unit-testable in isolation from the sync sweep + DB.
 */
import { parse as parseYaml } from 'yaml';

/**
 * Parse a spec document from raw text into an object. Specs show up in several
 * shapes — JSON or YAML (the common OpenAPI form), sometimes prefixed with a
 * UTF-8 BOM or surrounding whitespace — and a remote fetch can silently return
 * an HTML error page. Be liberal in what we accept, precise in what we reject:
 * try strict JSON first (fast path, no YAML-parser drift on the common case),
 * fall back to YAML 1.2 (a superset of JSON), and always validate the result is
 * an object so a bad spec yields a debuggable error rather than a crash later.
 *
 * @param raw    the spec text exactly as fetched/read
 * @param source a human label for errors (the URL or repo path)
 */
export function parseSpecDocument(raw: string, source: string): any {
  // A leading BOM and surrounding whitespace are meaningless for a spec but
  // break JSON.parse and can trip up YAML — strip them up front.
  const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).trim();
  if (!text) {
    throw new Error(`spec at ${source} is empty`);
  }
  // A leading '<' means HTML/XML — almost always a 404 or login wall returned in
  // place of the spec. No JSON ('{') or YAML spec starts this way, and YAML would
  // otherwise silently read the whole page as a scalar string, so reject it here
  // with a message that points at the real problem.
  if (text.startsWith('<')) {
    throw new Error(
      `spec at ${source} looks like an HTML/XML page, not a JSON or YAML spec — check the URL and auth`,
    );
  }

  let doc: any;
  let parseErr: Error | null = null;
  try {
    doc = JSON.parse(text);
  } catch {
    try {
      // maxAliasCount (yaml's default of 100) guards against billion-laughs
      // alias expansion from a hostile remote spec.
      doc = parseYaml(text);
    } catch (e) {
      parseErr = e as Error;
    }
  }

  if (parseErr) {
    throw new Error(`spec at ${source} is not valid JSON or YAML: ${parseErr.message}`);
  }

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    const kind = doc === null ? 'null' : Array.isArray(doc) ? 'array' : typeof doc;
    throw new Error(`spec at ${source} did not parse to an object (got ${kind})`);
  }
  return doc;
}
