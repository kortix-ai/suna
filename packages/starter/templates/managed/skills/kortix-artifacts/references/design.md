# Designing an artifact

Read this before you write the first line of an html artifact, and skim it
before a doc. Precedence: the user's own words, then the project's existing
design system (a tokens file, a brand skill, existing pages), then this file.

## 1. Decide the treatment

Designing is a given. Only the treatment changes.

| Request | Treatment |
|---|---|
| plan, memo, spec, report, decision record, runbook | **utilitarian**: a doc, or a calm page with a real type scale, considered spacing and a proper palette. No hero, few flourishes. |
| dashboard, tracker, tool, calculator | **UI**: information design first (section 6). |
| deck, landing page, launch page, game, an app they keep or share | **editorial**: a distinct identity for this subject (section 7). |

Unsure? A well-composed calm page is always acceptable. An over-designed one
sometimes is not.

## 2. The page contract (html)

The content server serves your files **exactly as written**. Nothing is
injected. So:

- Write a complete document: `<!doctype html>`, `<meta charset="utf-8">`,
  `<meta name="viewport" content="width=device-width, initial-scale=1">`, a
  `<title>`, your `<style>`, then the body.
- **Title:** a name, not a summary (see the naming rules in SKILL.md). It names
  the page in the gallery and the browser tab.
- **Sandbox:** the page runs sandboxed. On most deployments it has no origin
  of its own:
  - no cookies;
  - `localStorage` and `sessionStorage` throw, so wrap every read and write in
    `try/catch` and render correctly without them;
  - no access to Kortix.

  Use storage only for per-viewer conveniences (a remembered tab), never for
  data that must persist. Data that must persist goes into the artifact's
  files.
- **Libraries:** load from a CDN (cdnjs preferred, jsDelivr, unpkg) with a
  `<script src>` placed before the inline script that uses it. Pin an exact
  version (`chart.js/4.4.1`), never `@latest` or a bare name. Use a library
  only when it does substantial work (charts, a deck engine, syntax
  highlighting). Fonts: Google Fonts, always with a fallback stack.
- **Your own files:** images, data and scripts sit in the artifact's folder
  and load by **relative** path (`cards/7.png`, `data.json` with `fetch`). An
  artifact is always a folder; `publish` uploads everything in it.
- **Embeds:** third-party players (YouTube, Vimeo, maps) play only on
  deployments with a separate content host. Prefer a link with a thumbnail, or
  put the video file in the folder and use `<video src="media/clip.mp4"
  controls>`.
- **No print or PDF button on a page.** Export as PDF is for docs, in the
  viewer.
- **Forms** are page UI: handle `submit` in script with `preventDefault()`.
  Never point `action` at another site or `mailto:`.
- **Dialogs:** build confirmation steps into the page. Do not rely on
  `alert`, `confirm` or `prompt`.
- **Links** to other sites open in a new tab (`target="_blank" rel="noopener"`).
  Show an email address or phone number as selectable text, not only as a link.

## 3. Responsive and theme

- **Width:** the page works at phone width (~400 px) and on a large screen.
  The body never scrolls sideways.
  - Keep a side gutter of at least 16 px on `body` or one outer wrapper.
  - Rows wrap or stack to one column.
  - A flex or grid child that holds text, code or a table gets `min-width: 0`.
  - Only tables, code and diagrams may be wider, each inside its own
    `overflow-x: auto` box.
  - `img, video { max-width: 100%; height: auto }`.
- **Both themes:** the viewer follows the reader's system theme.
  - Define every color as a token on `:root` (the light values), and redefine
    the tokens only in `@media (prefers-color-scheme: dark) { :root { … ;
    color-scheme: dark } }`.
  - Style components through the tokens, never with a literal color that reads
    in one theme only.
  - Give `body` an explicit token background.
  - A design that deliberately commits to one look may stay single-theme: then
    set the background and every color explicitly.
- **Fit:** a one-screen app uses `height: 100%` on `html` and `body`, not
  `100vh`.

## 4. Fundamentals for every artifact

- **Ground it in the subject.** Name one subject, its reader and the page's
  single job. Include at least one detail only this subject would have: its
  real units, its document conventions, its terms of art. Real content only:
  real numbers with units and dates, never lorem ipsum. Missing data? Say so on
  the page.
- **Plan in tokens, in the file.** Before the page, write the plan as the
  `:root` block at the top of the `<style>`:
  - 4–6 named color tokens;
  - font tokens for 2+ roles (a display face used with restraint, a body face,
    a utility face for data);
  - a one-line layout comment.

  Derive every later color and type decision from those tokens. In your reply,
  one plain sentence on the direction is the most to say about the design.
- **Type.** Keep running text near 65 characters per line. Keep to one type
  scale. Give headings `text-wrap: balance` and uppercase labels a little
  letter-spacing. Use `font-variant-numeric: tabular-nums` where digits line
  up.
- **Neutrals.** Choose them deliberately: a grey with a slight bias toward the
  accent, or pure white or near-black chosen on purpose.
- **Spacing.** Use flex or grid with `gap` for sibling groups, not
  per-element margins.
- **Repeated elements.** Cards in a row, label/value pairs and badges share
  edges, baselines and padding. Pick a column count the items fill. Clipped
  text is a bug: let it wrap or scroll in its own box.
- **Cards by role.** Border, fill, radius and shadow set off the one element
  that needs it. The same radius and shadow on every block flattens the
  hierarchy. Open with big-number tiles only when those numbers are the point.
- **Charts to scale.**
  - One scale places marks, ticks and labels, and every label names a value
    the chart reaches.
  - Chart text uses the theme tokens.
  - Keep labels clear of marks and inside the bounds, and give every SVG shape
    an explicit fill.
  - Take one look at a chart of real numbers before you publish.
- **Complete at rest.** Everything meant to be read is visible once the page
  loads, with no scroll trigger and nothing waiting at `opacity: 0`. Size a
  hero to its content. A tool opens in a realistic working state: the user's
  data, or example rows clearly marked as examples.
- **Structure is information.** Numbering (01 / 02 / 03), eyebrows and
  dividers must encode something true. Number only a real sequence.
- **Build cleanly.**
  - Close every element and double-quote attributes.
  - Give keyboard focus a visible state, and respect `prefers-reduced-motion`.
  - Give each form control a stable `id`.
  - Watch selector specificity, so a class rule does not undo your section
    spacing.
  - Use Canvas for generative graphics instead of long hand-written SVG paths.

## 5. Copy

Words are design material.

- Write from the reader's side: name things by what people recognize
  ("notifications", not "webhook config").
- Use active voice. A control says exactly what happens ("Publish"), and its
  result says it happened ("Published").
- An error says what went wrong and how to fix it, with no apology.
- Prefer specific to clever.
- Avoid these devices: dash-set asides, "not X, but Y" framing,
  colon-then-reveal sentences, scare quotes, and stock phrases ("worth
  noting").

## 6. Dashboards and tools

A UI page is scanned and operated, not read top to bottom.

- Put the summary before the detail.
- Encode state in form as well as numbers (a pill, a chip, a severity stripe),
  so what needs attention shows at a glance.
- Semantic color (good / warning / critical) is separate from the accent.
- Give sparklines and charts the care you give type: a faint grid, an
  emphasized endpoint.
- Controls look like controls.

## 7. Editorial pages

The reader expects a distinct point of view.

- **Review the plan first.** Check the token plan against the subject. Revise
  any part that reads like the default for any similar page, then build
  exactly the revised plan.
- **The opener states the thesis:** the most characteristic thing in the
  subject's world (a headline, an image, a live demo).
- **Typography** carries the personality: a deliberate display and body
  pairing, not the families you would use anywhere else.
- **Motion** is one orchestrated moment rather than scattered effects. Often
  less.
- **Put the boldness in one place** and keep everything around it quiet.
- **Avoid the generated-design defaults** unless the user asks for them:
  - cream background, serif display and terracotta accent;
  - near-black with one acid-green pop;
  - a purple-to-blue gradient hero;
  - Inter or Space Grotesk as the safe face;
  - emoji as section markers;
  - everything centered;
  - the same large radius on every box.

## 8. Docs

A doc is Markdown that Kortix renders with one stylesheet, so the craft is
structure and words:

- One `# Title`, then the answer in the first paragraph.
- Short paragraphs, one idea each.
- Use a table for any comparison of 3+ attributes, and task lists (`- [ ]`)
  for next steps.
- Draw diagrams in ` ```mermaid ` fences (see `diagrams.md`).
- Put images and videos in `media/` next to `index.md` and reference them
  relatively: `![Funnel](media/funnel.png)`,
  `<video src="media/demo.mp4" controls></video>`.
- No HTML layout, CSS or scripts. Need charts or layout? Make an html
  artifact.

## 9. Check once, then publish

1. Publish, or save into the existing artifact.
2. Look once. `kortix artifacts open <id>` prints a signed `view` URL.
   - With a browser: open it once at desktop and at phone width, and fix what
     you see in one pass.
   - Without one: fetch the URL and the files it references, and check for
     `200`.
3. Stop there. Further polish is for the user to ask for.

A page whose point is logic (dates, money, scoring) may get one run of its
function on a sample input before you publish.
