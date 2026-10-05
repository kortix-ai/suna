# Typography

Values live in `visual-system.json` (keys `typography.*`). The rungs below are the allowlist. If a size is not here, it does not exist.

## Families

**Rule.** Use Roobert (`--font-sans`) for everything. Use Roobert Mono (`--font-mono`) only for code, commands, paths, identifiers and keys. — *Why:* two families are the whole type system. Mono is a signal for "this is literal text you can type", not a style. — *Where:* app, marketing, mobile, deck, email (stack only), image. — *When silent:* if the reader could copy the string into a terminal or a config file, set it in mono. Everything else is Roobert.

**Rule.** Set product nouns (session, repository, sandbox, skill, change request) in Roobert in running text. Do not set them in mono. — *Why:* the product shows these objects as plain words, and the glossary in `verbal/voice-and-tone.md` treats them as common nouns (K3 in `decisions.md`). The identifier of one (`session_id`, a path) is mono. — *Where:* app, marketing, deck, mobile. — *When silent:* the word is Roobert. The ID or the file name is mono.

**Rule.** Add no new font. Roobert and Roobert Mono are the entire type system. — *Why:* a third family breaks the one-product read. — *Where:* all surfaces except the exceptions below. — *When silent:* use Roobert.

**Rule.** Use the stack in `typography.stacks`, never a lone family name. — *Why:* the web loader declares Roobert with no fallback option, and the stack ends in the system sans. Roobert does not fall back to Inter: Inter appears only on the docs site (Blume stock theme, OPEN in `decisions.md` D8d). — *Where:* app, marketing, email, any HTML outside `apps/web`. — *When silent:* paste `--font-sans` and `--font-mono` from `tokens.css`. Add `fonts.css` where Roobert should load. Where Roobert must not load (email, an OG card, a page under a CSP with no web fonts), paste `--font-sans-system` and `--font-mono-system` instead (Q35).

**Rule.** Do not override the OpenType feature set. The web sets `ss03`, `ss04`, `ss09`, `ss10`, `ss14` and `palt` on `html` and `body` (`typography.feature_settings`). — *Why:* the stylistic sets define Roobert's Kortix letterforms. The reason for each set is not recorded; keep the set as shipped. — *Where:* app, marketing. `fonts.css` carries the five stylistic sets in `@font-face`. — *When silent:* inherit. Never write `font-feature-settings` on a component.

**Rule.** Load Roobert only on Kortix-owned surfaces until the license is confirmed. — *Why:* the files are Displaay Type Foundry commercial fonts, committed to a public repo and served at a public URL. Redistribution scope is OPEN (`decisions.md` D8a). — *Where:* image, email, partner pages, any third-party host. — *When silent:* use the system fallback (`--font-sans-system`) and say so in the PR.

## The scale. These rungs and no others.

Web redefines the small end. `text-xs` is 13px here, not 12px.

| Class | Size key | Role | Surface |
| --- | --- | --- | --- |
| `text-xs` | `typography.scale.xs` (13px) | Meta, captions, row descriptions. **The workhorse.** | app, marketing floor |
| `text-sm` | `typography.scale.sm` (14px) | Body, row titles, labels, button text. | app |
| `text-base` | `typography.scale.base` (16px) | Long-form prose only. | app prose, marketing body |
| `text-lg` | `typography.scale.lg` (18px) | Rare sub-heading. A split-modal title (`text-lg font-medium`). | app |
| `text-xl` | `typography.scale.xl` (20px) | Section page title. | app |
| `text-2xl` | `typography.scale.2xl` (24px) | Detail-view title. **App ceiling.** | app |
| `text-3xl` to `text-8xl` | `typography.scale.3xl` to `8xl` | Display and hero. | marketing, deck. Not in app chrome. |

**Rule.** Use only the rungs above. Write no arbitrary size (`text-[11px]`, `text-[0.8rem]`). — *Why:* if 13px is too big, the element is wrong, not the scale. — *Where:* app. Marketing may use the large rungs, and marketing text is 13px or larger. — *When silent:* change the layout, not the scale.

**Rule.** Treat `text-md` as non-canonical. Add no use. — *Why:* it is 14.4px, sits between two rungs, and its line height divides by the wrong size (`decisions.md` J-6, OPEN). — *Where:* app. — *When silent:* `text-sm`.

**Rule.** Use `text-xl font-medium` for the title of a project section page (Members, Secrets, Triggers). Use `text-2xl font-semibold tracking-tight` only for a detail-view title. — *Why:* `text-2xl` is the app ceiling, not the default. A section page that takes the ceiling outranks its own detail views (Q7). — *Where:* app. — *When silent:* `text-xl font-medium`.

**Rule.** Keep display type inside the surface ceiling: `text-2xl` in app chrome, `text-7xl` in marketing. — *Why:* app chrome is dense and calm. Large type is a marketing budget. — *Where:* app, marketing. — *When silent:* name the surface, then follow its column below.

**Rule.** Scale inline elements with their context in `em`. — *Why:* a fixed-size chip inside an `h1` "read as body text inside a title" (#7684: inline code is 0.9em inside `h1` to `h6`). — *Where:* app. — *When silent:* if the element lives inside a heading, size it in `em`.

**Rule.** A page has one `h1`. A section of a page, and a standalone one-section file, takes `h2`. Pick the size from the type scale, not from the tag. — *Why:* a section file that opens with `h1` breaks the outline when the page embeds it, and the tag has no say in size here (Q36). — *Where:* marketing | any HTML outside `apps/web`. — *When silent:* `h2` for the section heading, `h3` below it.

## Weight and tracking

| Need | Value |
| --- | --- |
| Body, meta | `font-normal` (the default, do not write it) |
| Row title, label, active nav | `font-medium` |
| Detail title, hero | `font-semibold` + `tracking-tight` |
| Anything else | Not available. No `font-bold`, `font-light`, `font-extralight`. |

**Rule.** Use only weights 400, 500 and 600. — *Why:* the ladder has three steps. The font files carry 300 to 900, so off-ladder weights render but break the system. — *Where:* app, marketing, mobile, deck, email, image. — *When silent:* 500 for emphasis, 600 for a title. Never bold.

**Rule.** Pair `tracking-tight` with `text-2xl` and up. Never track body text. Do not loosen tracking anywhere. — *Why:* tight tracking tames large type. Loose tracking on small type reads as a label style the system rejects. — *Where:* app, marketing, deck. — *When silent:* default tracking.

**Rule.** Use the line height that ships with the rung. Use `leading-snug`, `leading-tight` or `leading-relaxed` on multi-line titles and prose only. Write no `leading-[…]` or `tracking-[…]`. — *Why:* the rung already pairs size and line height (`typography.scale.*.line_height`). — *Where:* app, marketing. Targets: headings 1.15 to 1.25, body 1.5 to 1.6, captions 1.4. — *When silent:* inherit. In HTML outside `apps/web` (no Tailwind utilities), write `var(--tracking-tight)` and `var(--leading-tight|snug|relaxed)` from `tokens.css`, never a literal such as `-0.025em` or `1.15` (Q35).

**Rule.** Keep the body measure at 45 to 75 characters. Set text flush-left, ragged-right. Never justify body text. — *Why:* readability, and hierarchy stays visible. — *Where:* marketing, deck, email, docs prose. — *When silent:* cap the width, not the size.

**Rule.** Wrap by role: `text-balance` on titles, `text-pretty` on descriptions, `wrap-anywhere` on error strings and user-supplied strings. — *Why:* a long ID or a raw error should break, not overflow (#7096, #8491, #7671). — *Where:* app, mobile (equivalent props). — *When silent:* add `text-balance` to any title that can wrap.

**Rule.** Use `tabular-nums` on counts and any number that changes. — *Why:* a 9 to 10 change must not move the truncation point or the neighbors (#7067, #7191). — *Where:* app, mobile. — *When silent:* numbers that tick or sort get `tabular-nums`.

## Roles (app)

| Role | Classes |
| --- | --- |
| Section page title | `text-xl font-medium text-foreground` |
| Detail title | `text-2xl font-semibold tracking-tight` |
| Split-modal title | `text-lg font-medium text-balance` |
| Panel section label | the `Label` component (`text-sm font-medium`) |
| Row title | `text-sm font-medium` |
| Row meta, description | `text-xs text-muted-foreground` |
| Description under a modal title | `text-sm text-muted-foreground text-pretty` |

## Eyebrows, uppercase and mono as a label

**Rule.** Do not set uppercase or letter-spaced micro-headings in app chrome. The mono-uppercase `Badge` chip is the one exception (D4e, #6952). — *Why:* all-caps eyebrows are an LLM default. The chip is a deliberate Jay primitive: a tight mono label with an inset ring. Its colors must still come from tokens (the raw palette in `badge.tsx` is tracked debt). A command inside a badge keeps its own case: `font-mono tracking-normal normal-case` (#8421 `CopyCommandBadge`). — *Where:* app, mobile (never letter-spaced eyebrows). — *When silent:* write a sentence-case label in `text-xs text-muted-foreground`.

**Rule.** Marketing and decks may set a mono-uppercase eyebrow: one per section, at `text-xs`. The `/design-system` route is a marketing-profile page: its `BrandSection` micro-label is that eyebrow, not app chrome (Q35). — *Why:* the homepage and the deck engine (`engine/parts.tsx`, `SectionHead`) ship it. D4e allows decks. The kit extends D4e to marketing for the same reason (K3 in `decisions.md`). — *Where:* marketing, deck. Not app, not mobile. — *When silent:* skip the eyebrow. The title can carry the section.

## Per surface

| | app | marketing | mobile | deck | image | email | CLI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Family | Roobert + Mono | same | Roobert static files; Mono Regular only | same | Roobert composited after generation | `--font-sans-system` | the terminal font |
| Scale | `xs` to `2xl` | up to `7xl` hero; floor `xs` | NativeWind Tailwind 3 scale: `text-xs` is 12px. `Text` variants in `components/ui/text.tsx` own size and weight | pt scale below | 1 to 5 words | `--email-*`: 22px title, 14px body, 13px kicker, 12px small | none |
| Weights | 400, 500, 600 | same | regular, medium, semibold | same | 400, 500, 600 | 400, 500, 600 | none (bold only if the terminal needs it) |
| Eyebrow | none (Badge chip only) | mono-uppercase allowed | none | mono-uppercase allowed | none | **sentence-case kicker** | none |
| Inputs | 14px | 16px | 16pt, `INPUT_FONT_SIZE` | n/a | n/a | n/a | n/a |

**Deck scale (pt, for slide files and exports).**

| Role | Size |
| --- | --- |
| Hero | 40 to 54pt, one per cover, semibold, tight tracking |
| Display | 28 to 36pt |
| Heading | 18 to 22pt, medium or semibold, leading 1.15 to 1.25 |
| Body | 11 to 12pt, regular, leading 1.5 to 1.6, measure 45 to 75 characters |
| Caption | 9 to 10pt, leading 1.4 |

A route deck (`/presentations/<slug>`) uses the web rungs: titles `text-3xl` to `text-4xl font-medium tracking-tight`, body `text-base`. Use 3 to 4 text styles per slide: title, heading, body, caption.

**Marketing px scale.** Hero `text-6xl` to `text-7xl` (56 to 72px). Display `text-4xl` to `text-5xl` (36 to 48px). Heading `text-2xl` to `text-3xl` (24 to 28px). Body `text-base` (16px). Caption `text-xs` to `text-sm` (13 to 14px). Hero tracking is `tracking-tight`. H1 sizes differ by page today (48, 60, 36 and 44px measured); pick the rung from this scale and use it for every page of the same type.

**Rule (email).** Use `--font-sans-system`, weights 400, 500 and 600, and a sentence-case kicker. Show the wordmark as an image, not as bold text. Take the sizes from `--email-*` in `tokens.css`: title, body, kicker, small. — *Why:* clients cannot load Roobert reliably, and the old shell set the wordmark at weight 700 with 0.5px tracking and an uppercase kicker. `EMAIL_FONT_SANS` in `brand-tokens.generated.ts` is the same stack, built by the generator with Roobert removed (Q27, Q34). — *Where:* email. — *When silent:* `--font-sans-system`, no Roobert and no `@font-face`.

**Rule (CLI).** Do not style type. Use plain text, one accent color and dim for secondary text. Honor `NO_COLOR`. — *Why:* the terminal owns the font. — *Where:* CLI. — *When silent:* plain text.

**Rule (image).** Do not render text with the image model. Reserve the space and composite real copy after (in `--font-sans-system` until D8a closes), or use 1 to 5 user-supplied words. — *Why:* models corrupt text. — *Where:* image. — *When silent:* leave the space empty. See `art-direction.md`.

## Known drift (for the PR body, not for imitation)

- Loaders declare weight `100 900`. The files carry `300 900`. Set the loader to `300 900`.
- Off-ladder weights exist in `invites/[inviteId]/page.tsx`, `blog-cover.tsx`, `use-cases/covers.tsx`, `not-found-state.tsx`.
- Mobile bundles Light, Bold and Heavy files with no class use. Markdown headings use Bold, which breaks the ladder. `apps/mobile/AGENTS.md` still says h1 is `font-extrabold`. Fix the doc.
- The design-system page lists `text-xs` as 12px. It is 13px.
- `badge.tsx` keeps `rounded-[5px] py-[0.1rem] text-[0.8rem]` in the chip base string. `audit.sh` flags three hits. D4e keeps the chip, but its geometry is debt: do not copy it and do not allowlist it. The nearest steps are `rounded-sm`, `py-0.5` and `text-xs`; a design lead confirms the swap (Q40).
- `Input` is `text-sm` (14px) at every size except `xl` (`text-base`). iOS Safari zooms the page when a focused input is under 16px, and the viewport now allows pinch zoom. OPEN product debt (Q42): set 16px for inputs on touch widths. Do not set `maximum-scale` to hide it.

## Rationalization table

| Thought | Reality |
| --- | --- |
| "13px is too big for this caption" | The scale has no rung below `text-xs`. Change the layout. |
| "Bold makes the title pop" | The ladder stops at semibold. Increase the rung. |
| "I will use mono so it looks technical" | Mono marks literal text. Decoration is a rejected default. |
| "An eyebrow helps scanning" | In app chrome the title does that job. Marketing and decks may. |
| "Stock Tailwind `text-xs` is 12px" | Not here. It is 13px on web and 12px on mobile. |

