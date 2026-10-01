# Art direction

How a Kortix image, cover, share card or screenshot is directed. The goal is one clean, on-brand image. Words in the image come from `verbal/voice-and-tone.md` and `verbal/claims.md`. The mark comes from `brandmark.md`. Art that ships in the product (shaders, pixel mark, dot matrix) is in `graphic-elements.md`.

**Output.** PNG by default. SVG only when the request says SVG. For the web, also export WebP at about 80% quality with explicit width and height (no layout shift) and descriptive alt text.

## Direction

**Rule.** Direct every image as premium utilitarian minimalism, grounded in the product. Show agents, repositories, sandboxes, sessions, terminals, change requests and traces. Do not show sci-fi. — *Why:* Kortix is a working tool for companies. A glowing-brain image says "AI hype", which the verbal rules reject. — *Where:* image, deck, marketing. — *When silent:* ask what real thing in the product the image is about. Draw that.

**Rule.** Use "change request", not "pull request", and "Kortix", not "Kortix/Suna", in any word that appears in or beside an image. — *Why:* the glossary in `verbal/voice-and-tone.md` sets the nouns. "Pull request" and "Kortix/Suna" are not Kortix words. — *Where:* image, social. — *When silent:* `verbal/voice-and-tone.md`.

**Rule.** Show product truth with a real screenshot. Never generate product UI. — *Why:* image models hallucinate interfaces, and a made-up interface is a false claim (`verbal/claims.md`). — *Where:* image, deck, marketing, social. — *When silent:* screenshot the real Kortix UI at 2x and frame it. Use the same theme as the surrounding surface, since a light screenshot inside a dark layout reads as a bright panel. Crop with `object-top` to keep the top of the screen, where the product is.

**Rule.** Use exactly one brand accent, on neutral surfaces. Never a rainbow. — *Why:* the one-accent rule is the system's color discipline (`color.md`). — *Where:* image, deck, social, email. The multi-hue `KortixAsterisk` gradient is a bullet in the product, not an image style. — *When silent:* neutral, and name the one accent by role (`kortix-base`). A status hue appears only on a mark that shows that state, one hue per state (`color.md`).

**Rule.** Give an image one focal point, strong whitespace, one icon family and 1px borders. Shadows are soft and subtle. — *Why:* calm density is the brand. A busy dashboard or a meaningless chart is noise (`effects.md`). — *Where:* image, deck, marketing. — *When silent:* remove an element.

**Rule.** Use the art layer in an image only as a still: a Paper shader frame, the pixel or dither mark, a dot-matrix glyph, or a wallpaper download. Composite it. Do not ask an image model to imitate it. — *Why:* the art layer is a sanctioned set of shipped modules (D4d). A model's imitation is a fifth style. — *Where:* image, marketing, social. — *When silent:* take a still from `apps/web/public/wallpapers/downloads/` or render the module. Dark art stays dark in both themes (`graphic-elements.md`).

**Rule.** Avoid: robot mascots, glowing brains, neon grids, holograms, glassmorphism, rainbow gradients, invented logos, generated product UI, stock office scenes, busy dashboards, meaningless charts, and the words "futuristic", "next-gen" and "seamless". — *Why:* each is a generic-AI signal. — *Where:* image, deck, social, marketing. — *When silent:* if it could appear in any AI company's deck, cut it.

**Rule.** Reject, and do not ship, an image with a drawn or garbled logo, more than one accent, mangled text, generated product UI, or generic AI slop. — *Why:* these are the five failure modes seen in practice. — *Where:* image. — *When silent:* regenerate or crop.

## Mark, text, crop

**Rule.** Composite the official mark after generation. Place one mark. — *Why:* never let the image model invent, redraw or restyle the mark (`brandmark.md`, D6). A small corner logo plus a large central logo is two marks, and it is retired. — *Where:* image. — *When silent:* the symbol, top-left, on a 16:9 image. A hero, blog, social, launch or cover image that needs a brand anchor uses one larger symbol or logo instead of the corner mark, not both. File: `apps/web/public/brandkit/`.

**Rule.** Do not render text with the image model. Reserve the space and composite real copy afterward (in `--font-sans-system`, or Roobert where [typography.md](typography.md) allows it). If text must live in the image, use 1 to 5 user-supplied words. — *Why:* models corrupt text. — *Where:* image. — *When silent:* leave the space empty. Ideogram renders text best, but compositing is still the default.

**Rule.** Place copy on a calm area: whitespace or a one-tone field. Never over busy art. Set it flush-left, one headline, in the type ladder (`typography.md`): semibold at most. — *Why:* contrast is priority 1. — *Where:* image, deck, social. — *When silent:* move the copy, do not add a scrim.

**Rule.** Pin the aspect ratio in the prompt, and keep critical content crop-safe. — *Why:* a forgotten ratio is the number one cause of unusable output. A card that shows at 1:1 on one platform and 1.91:1 on another loses its edges. — *Where:* image. — *When silent:* generate at the native size, then check the tightest crop of the target set. Keep the mark and the headline inside it.

| Surface | Size |
| --- | --- |
| OG and blog hero | 1200 x 630 (1.91:1) |
| X post | 1200 x 675 (16:9). Header 1500 x 500 |
| LinkedIn post | 1200 x 627. Personal cover 1584 x 396 |
| Square (Instagram, launch card) | 1080 x 1080 |
| Story, reel | 1080 x 1920 (9:16) |
| Avatar | 1000 x 1000 (`brandkit/Profile Picture/`) |

## OG and share cards

**Rule.** Make a share card from one template: the symbol, the page title, black and white, light theme only, 1200 x 630. Set the title in `--font-sans-system` from `tokens.css` until D8a closes (Q30). A share unfurl has no theme, so ship no dark variant. — *Why:* every product page shares one generic `banner.png` today. The `/api/og/template` route (still in the tree on 2026-10-01: `route.tsx` and `template-url.ts`) is off-brand (indigo and slate colors, weight 700, no mark, no Roobert), and the docs share image is a generic blue tile with the old repo name. — *Where:* image, marketing, docs. — *When silent:* use `apps/web/public/banner.png` until a per-page template exists. Do not use `/api/og/template`. Rebuilding it from the tokens is an open cleanup (`decisions.md`).

**Rule.** Take the card title from the page's H1, or its nav label when the H1 is a sentence, in sentence case. When the nav label is absent from the tree, use the page eyebrow, then the route slug in sentence case. Cite the source under Guesses. — *Why:* the card must match the page it shares, and the page source may be absent (Q30). — *Where:* image (OG). — *When silent:* the nav label, then the eyebrow, then the slug (Q54).

**Rule.** Set the OG title at the top rung of the marketing type ceiling in [typography.md](typography.md), and no higher. — *Why:* the image column names no rung, so the nearest column's ceiling holds (Q30). — *Where:* image (OG). — *When silent:* the marketing ceiling. Check that the title reads at 600 x 315.

**Rule.** The OG symbol size and the edge margin are OPEN (D8b). Take the symbol height of the nav logo and a margin from `spacing.steps`. State both numbers under Guesses. — *Why:* D8b says do not invent numbers, and a per-card margin makes cards drift (Q30). — *Where:* image (OG). — *When silent:* the nav logo height (`navbar.tsx`, the `Logo` height), and spacing step 16 (about 59px at `--spacing`) on all four sides. Place the symbol top-left and the title flush-left on the bottom margin (Q54).

**Rule.** Keep the symbol and the title inside the tightest crop of the target set. An OG card targets 1.91:1 only. When a 1:1 crop would cut either, say so under Guesses. — *Why:* a card that shows at two ratios loses its edges (Q30). — *Where:* image (OG). — *When silent:* the full 1.91:1 frame is the target.

**Rule.** An image-model prompt for a card asks for a plain plate only, and the card is composited in HTML. — *Why:* the template is flat, so the model adds nothing it allows (Q30). — *Where:* image (OG). — *When silent:* one short plate prompt, the reject list, and composite everything else.

**Rule.** A card spec in Markdown cites token names, never a hex value. HTML for a card uses `var(--*)`. Only email HTML may hold hex ([color.md](color.md)). — *Why:* the V check greps every output file for hex (Q30). — *Where:* image (OG). — *When silent:* token names.

**Rule.** Declare the real size in the tags. — *Why:* the careers share image is 295 x 171 while its tags claim 380 x 253. — *Where:* marketing. — *When silent:* measure the file.

**Rule.** Keep the brand name out of the page title when the template adds it. — *Why:* titles read "Kortix pricing | Kortix" because the template and the page both add it. — *Where:* marketing. — *When silent:* write "Pricing". The template adds "| Kortix".

## Tools and workflow

- General generation: Gemini or Flux. Brand consistency across a set: Flux multi-reference. Text that must live in the image: Ideogram, but prefer to composite.
- Product UI: never generate. Screenshot it.

1. Confirm the surface, the aspect ratio and any required text or facts. Default sensibly. Ask one question only when the surface or the required text changes the direction.
2. Write one short prompt: subject + Kortix product truth + brand direction (neutral, one accent) + composition + aspect ratio. Over-specifying produces worse images.
3. Generate as PNG. Composite the mark and any exact text.
4. For the web, export WebP with explicit dimensions and alt text.
5. Reject anything on the failure list above.

## Per surface

| | image | deck | marketing | social video | email | app | CLI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Imagery | generated art + composited mark | real screenshots in `Shot`, capped in `vh` | product screenshots, covers with grain | frame the real product | none, or the logo PNG | none; art only in panes | none |
| Palette | neutral + one accent | neutral + `kortix-*` verdicts | neutral + one accent | neutral + one accent | `tokens.css` | tokens | ANSI |
| Text | 1 to 5 composited words | web type rungs | Roobert | captions in the type ladder, one accent for the key word, no outline | `--font-sans-system` | tokens | plain |

**Social video captions.** Use the type ladder (semibold at most) and one accent for the key word. Do not use a bold outlined sans-serif or a second color. — *Why:* a bold outlined sans-serif with a second highlight color breaks the one-accent and weight rules. (K3 in `decisions.md`.)

