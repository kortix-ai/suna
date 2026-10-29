---
name: kortix-design
description: "How every interface you build should look: a dashboard, an analytics view, an internal tool or pipeline, a Kortix App UI, a website, a landing page, a component, a redesign. Load before you write the first className or the first user-facing string, when you review a UI, when a page looks generic or 'AI-made', when you add motion, or when you need the exact name for a design or animation concept."
---

# Kortix Design

Make every interface simple, calm and clean. A person should see what the
page is for and what to do next, with nothing in the way.

**The user's style comes first.** If the user asks for a theme, brand,
colors, font or mood ("dark and moody", "our brand blue", "playful"), build
exactly that. Apply the rules below inside their style, never over it. Use
the default look below only when the user gives no style.

When `kortix-apps`, `webapp` or `website-building` disagree with this skill
on how something looks, this skill wins. If the App uses `@kortix/ui`, load
`kortix-ui` and use its tokens.

| Need | Read |
|---|---|
| Type, color, spacing, surfaces, accessibility, copy, responsive, dark mode, library picks, clean code | `references/craft.md` |
| Any animation or transition | `references/motion.md` |
| The exact name for a design or motion concept | `references/vocabulary.md` |

## Start with the smallest layout

The first version is the plainest one that does the job. Add more only when
the user asks for it.

- **The page opens on the data.** Title row, controls row, then the items.
  No hero, no banner, no featured block, no carousel, no slide counter.
- **No sidebar by default.** One column, left-aligned, max width about
  1200px. Use a sidebar only when the App has 4 or more separate sections.
  2–3 views are tabs.
- **No text the user did not ask for.** No tagline, no intro paragraph, no
  line above the title, no "about" or "context" box, no promo card, no
  footer, no credits line.
- **One row of controls.** Tabs on the left; search and filter on the right
  of the same row, centered on one line. On a phone they stack: tabs, then a
  full-width search.
- **Two edges.** Everything lines up on one left edge and one right edge.
  Nothing floats in between.
- **Items in a plain grid or list.** Same image ratio, same gap, no text
  laid over images.
- **Ask of every element:** does the person need this to do the job? If
  not, delete it.

## How it should look (default)

- **Quiet surfaces.** White or near-white background, near-black text, one
  gray for secondary text. Dark mode uses the same tokens.
- **One accent color**, used only for the main action and selected states.
  Most screens have almost no color.
- **Light gray fills, not boxes.** Show grouping, inputs and selected items
  with a soft gray fill. Use a thin border only where something must stand
  out from the page (a dropdown, a secondary button). Never put a border and a
  heavy shadow together.
- **Few, soft shapes.** One small radius for controls (about 8px), one for
  panels (about 12px). No card inside a card.
- **Plain type.** One sans-serif family. Sizes: a bold page title (~24px),
  body 14–16px, muted 13px. Hierarchy comes from weight and gray, not from
  many sizes.
- **Space does the work.** Group related things close together and leave
  clear space between groups. Use space before you use a line.
- **Icons only when they help.** One icon set, thin strokes, 16–20px,
  gray. No icons in colored circles. No emoji.
- **No decoration.** No gradients, glows, blobs, patterns, badges for their
  own sake, or "AI sparkle". If a section feels empty, fix the content.
- **Real words.** Sentence case. Short labels. Buttons say what they do
  ("Save changes"). No lorem ipsum, no invented numbers or logos.

## Components

Every component is simple: a soft fill or nothing, one thin border at most,
plain text, no decoration. It looks finished in every state.

- **Header row.** The page title on the left: bold, about 24px, slightly
  tight letter-spacing. Page-level actions on the right. A secondary icon
  action stands alone with no box around it.
- **Search field.** Wide, light gray fill, no border, about 8px radius,
  about 40px tall. A gray search icon inside on the left. The placeholder
  names what it searches ("Search orders"). It filters as the person types.
- **Tabs.** Plain text in one row. A count follows the label in muted gray.
  Only the selected tab has a light gray rounded fill. No underlines, no
  borders, no background on the others. On small screens the row scrolls
  sideways; it never wraps.
- **Filter button.** White, thin light border, about 8px radius, a small
  icon plus one word. When a filter is on, the button shows its value.
- **Buttons.** The main action is the only filled button, in the accent
  color. Secondary buttons are white with a thin light border. Quiet actions
  are plain text or a bare icon. One height per row (about 36px), short verb
  labels.
- **Badges.** A soft, pale fill in the badge's own color, with darker text
  in the same hue. No border, no dot, no icon. Small radius (about 6px),
  medium weight, short single-word labels ("In review", "Paid"). Gray for
  neutral states; one quiet hue per meaning (blue for in progress, green for
  done, amber for waiting, red for a problem).
- **Dropdowns and menus.** White panel, thin light border, soft shadow,
  about 12px radius. An optional small muted label names the group. Items
  are plain text rows about 36px tall, with no dividers and no icons unless
  they carry meaning. The selected item has a check on the left, and the
  other items are indented to line up with it. Hover and keyboard focus
  show a light gray row. Escape closes it. It opens from its button, aligned
  to its edge. A long menu gets a search field at the top.
- **List rows.** A title in normal weight, then one quiet line of metadata
  in gray (status badge, date, source). Rows are separated by space or a
  thin line, never by a box around each row. The whole row is clickable and
  shows a light gray fill on hover.
- **Inputs.** A visible label above, a thin light border or a light gray
  fill (one style for the whole App), about 8px radius. A help or error line
  below in small text. The focus ring is clear and calm.
- **Dialogs and side panels.** A clear title, the content, and the actions
  at the bottom right: the main action last. Close with Escape and a small
  icon button. Nothing else in the corners.
- **Toasts.** Short, bottom corner, one line plus an optional "Undo". No
  icons or colors for success; red only for errors.
- **Space.** Leave generous space between the header row and the controls
  below it. Content starts right under the controls.
- **Empty and loading.** An empty view says what would be here and offers
  one action. Loading shows gray placeholder rows in the same shape as the
  real rows. Never a blank page and never a full-page spinner.

## Dashboards, analytics and internal tools

Most Kortix Apps are dashboards, analytics views and internal tools (a
content pipeline, a CRM, a tracker). They are used every day, so they stay
calm and fast to scan.

```
Overview                                   [Last 30 days v]  [Export]

Revenue        Orders        Conversion      Avg. order
$48,210        1,284         3.2%            $37.54
+12% vs prev   −3% vs prev   +0.4 pts        +2%

Revenue over time
  one line chart, faint gridlines, labels on the axis, no box

Recent orders                                   [Search] [Filter]
Order      Customer        Status       Amount
#1042      Sample name     Shipped      $120.00
```

- **Start with the answer.** The top row shows the 3–5 numbers that matter
  most: a small gray label, a large number, and the change in a small line
  under it. No icons, no colored boxes, no card around each number.
- **Pick the chart by the question.** Change over time: line. Comparing
  items: bar. Part of a whole with 2–5 parts: a stacked bar. Avoid pie charts,
  3D charts and donut charts with many slices.
- **Charts stay quiet.** Faint gridlines, no chart border, no shadow. One
  color for one series; a second color only for a second series. Label the
  axes and show values on hover.
- **Tables sit on the page.** No outer box. A thin line between rows, a
  slightly bold or gray header row, numbers right-aligned in tabular
  figures. Status shows as a badge (see Components).
- **Pipelines and boards** (draft → in review → published): one column per
  stage, the stage name with its count on top, simple item rows below. The
  stage color appears only in its badge, never as a full colored column.
- **One date range and one filter row** control the whole page, top right.
  Every number and chart on the page follows them.
- **Real data or clearly labeled sample data.** Never invent business
  numbers. When there is no data yet, the chart area says so and offers the
  next step ("Connect a source", "Add your first video").
- **Same layout on every page.** The navigation stays in the same place.
  The current page is marked.

## Pages that work the same way

- **One main action per screen.** It is the only filled button.
- **Every state is designed.** Hover, pressed, focus ring, disabled,
  loading, empty, error. Errors say what went wrong and how to fix it,
  next to where it happened.
- **Nothing jumps.** Space for images, numbers and loading rows is
  reserved. Hover never changes size or weight.
- **Works on a phone.** At 375px wide there is no sideways scrolling of the
  page. Columns stack. Tap targets are at least 44px.
- **Motion is small and fast.** Use it only to show what changed, under
  300ms. Nothing animates on keyboard shortcuts. See `references/motion.md`.

## Signs of a sloppy, AI-made page

Remove every one you find:

- Purple or blue gradients, glowing buttons, gradient text.
- A centered hero with three identical icon cards under it.
- Everything boxed in identical cards with shadows.
- Icons in colored circles or squares. Emoji as icons.
- Tiny uppercase labels above every heading. "01 / 02 / 03" on things that
  are not steps.
- One word in a headline set in a different color or in italics.
- Arrows (→, ↗) on every link. Middle dots (A · B · C) everywhere.
- A sidebar holding a logo, a tagline, a promo block and a footer note.
- A tagline above the title, a "context" or "about" box, credits lines.
- A big featured hero with text on the image and a "01 / 08" counter.
- Search and filter on their own row, out of line with the tabs.
- Fake screenshots, fake stats, fake logos, "Acme", "John Doe".
- Words like "seamless", "unlock", "elevate", "supercharge".
- Fade-in on every section, hover lift on every card, looping animations.

## Clean code

- One styling system. Colors, sizes and radii come from tokens, never raw
  hex values or one-off pixel values in components.
- Reuse installed components (shadcn/Radix, cmdk, sonner) before writing
  your own. Tune their look to these rules.
- A repeated set of classes becomes a component or a variant.
- No dead code, no unused props, no comments that repeat the code.
- Use real elements: `<button>` for actions, `<a>` for links, a `<label>`
  for every input.

## Before you finish

1. Open the running App with `agent-browser`. Screenshot it at 375px and
   1280px, in light and dark.
2. Check the screenshots against the style the user asked for (or the
   default look), "Components", the dashboard section when it applies, and "Signs of a
   sloppy, AI-made page".
3. Fix what fails, then screenshot again. You are done when the new
   screenshots pass every check.

