/**
 * Markup in, visible text out — for assertions against `renderToStaticMarkup`
 * output.
 *
 * This is NOT a sanitizer and must never be used as one. Its input is markup
 * this repo's own components just produced, and its output is fed to
 * `expect(...)`, never back into a DOM. If you find yourself reaching for it in
 * application code, you want a real sanitizer instead.
 *
 * WHY THE LOOP, given the above. Each of the three test files that needed this
 * previously inlined a single `html.replace(/<[^>]*>/g, '')`. CodeQL's
 * `js/incomplete-multi-character-sanitization` rule flags that shape as a
 * high-severity finding, and it is technically right: one pass over
 * `<scr<span>ipt>` leaves `<script>` behind, because removing the inner tag
 * splices the outer one back together. Not reachable here — there is no
 * adversary supplying our own components' markup — but "unreachable today"
 * is a worse answer than "correct", and a suppression comment would ask every
 * future reader to re-derive that reasoning.
 *
 * Running to a fixed point costs one extra pass on well-formed input (the
 * second pass finds nothing and exits) and makes the function actually
 * complete, so the rule has nothing left to report.
 */
export function stripTags(html: string): string {
  let previous: string;
  let current = html;
  do {
    previous = current;
    current = current.replace(/<[^>]*>/g, '');
  } while (current !== previous);
  return current;
}
