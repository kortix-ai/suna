# Brandmark

The Kortix mark, its names, its files, and where it goes. Fills and surface colors are tokens: see `color.md` and `visual-system.json`.

## Vocabulary (D6)

One term per asset. Use these words in code comments, PRs, prompts and file names.

| Term | Means | Do not call it |
| --- | --- | --- |
| **symbol** | The mark alone. | brandmark, icon, logomark |
| **logo** | Symbol + wordmark lockup. | logomark, brandmark |
| **mark** | The generic word for either the symbol or the logo, when a rule applies to both. | icon, brandmark |
| **wordmark** | The word "Kortix" alone. Exists on mobile only. | logomark text |
| **brandmark-bg** | The outline wallpaper (`kortix-brandmark-bg.svg`, wallpaper id `brandmark`). | brandmark |

**Rule.** Use "symbol", "logo", "mark" (either asset), "wordmark" and "brandmark-bg", and no other word. — *Why:* the brand kit calls the symbol "Brandmark" and the lockup "Logomark", the React component `KortixLogo` calls the symbol `icon` and the lockup `brandmark`, mobile calls them `symbol`, `logomark` and `text`, and the wallpaper registry uses `brandmark` for a third thing. Five vocabularies produced three conflicting rules (`assets` audit). — *Where:* all surfaces. — *When silent:* if you must name a file whose name uses an old word, write the new term and the file name in code font: "the symbol (`Brandmark Black.svg`)".

## The files

Canonical files live in `apps/web/public/brandkit/` (D6). Verified to exist at this commit.

| Term | File | Fill | Use |
| --- | --- | --- | --- |
| symbol, SVG | `apps/web/public/brandkit/Logo/Brandmark/SVG/Brandmark Black.svg`, `Brandmark White.svg` | black / white | **Master.** Light surfaces take black, dark surfaces take white. |
| symbol, PNG | `apps/web/public/brandkit/Logo/Brandmark/PNG/Brandmark Black.png`, `Brandmark White.png` | black / white, alpha | Where SVG is not accepted. |
| logo, SVG | `apps/web/public/brandkit/Logo/Logomark/SVG/Logomark Black.svg`, `Logomark White.svg` | black / white | Lockup. |
| logo, PNG | `apps/web/public/brandkit/Logo/Logomark/PNG/Logomark Black.png`, `Logomark White.png` | black / white, alpha | Email and image compositing. |
| avatar | `apps/web/public/brandkit/Profile Picture/Avatar Black.png`, `Avatar White.png` | dark field + white symbol / light field + black symbol | Social profile pictures. |
| bundle | `apps/web/public/brandkit/kortix-brand-assets.zip` | | Download for partners. No script regenerates it. It can drift from the loose files. |
| symbol (app copy) | `apps/web/public/kortix-symbol.svg` | black | Provider branding, docs, tray source. **Off-master proportion**, see below. |
| symbol (docs) | `apps/web/blume-public/kortix-symbol.svg`, `kortix-symbol-white.svg` | black / white | Docs site. Intentional copies. The white symbol exists nowhere else in `public/`. |
| favicon (legacy) | `apps/web/public/favicon.svg`, `favicon.png` | dark mark on a light tile | **Off-master.** The tile color is no token. Still referenced by the JSON-LD `logo` in `[locale]/layout.tsx`, the blog and use-case pages and `lib/web-notifications.ts`. Use the files in the app-icon table below in new code (Q39). |
| brandmark-bg | `apps/web/public/kortix-brandmark-bg.svg` | white outline, fading | Wallpaper `brandmark`. |
| OG banner | `apps/web/public/banner.png` | | The one static share image. |
| wordmark (mobile) | `apps/mobile/assets/brand/Logomark-Text-Black.svg`, `Logomark-Text-White.svg` | black / white | Mobile auth. Not in the brand kit. |
| mobile symbol | `apps/mobile/assets/brand/kortix-symbol.svg` (black), `Symbol.svg` (white), `Logomark-Black.svg`, `Logomark-White.svg` | | `KortixLogo.tsx`. |
| desktop icon | `apps/desktop-electron/build/icon.png`, `icon.icns`, `icon.ico` | | Electron app icon. Tray: `assets/tray/trayTemplate.png`. |
| wallpaper downloads | `apps/web/public/wallpapers/downloads/kortix-{symbol,logo}-{dark,light}-*.png` | | Made by `apps/web/scripts/generate-wallpapers.mjs` from the brandkit files. |

Duplicate files to delete in a cleanup change (not an agent decision): `apps/web/public/logomark-white.svg` and `kortix-logomark-white.svg` have no code reference.

### React components

| Component | File | Variants | Notes |
| --- | --- | --- | --- |
| `KortixLogo` | `apps/web/src/components/ui/kortix-logo.tsx` | `icon` (symbol), `brandmark` (logo) | Canonical. Renders `currentColor`. **Naming conflict:** its `brandmark` variant is the logo, but the brand kit and D6 use "brandmark" for the symbol and the wallpaper. OPEN: rename the variants to `symbol` and `logo` and migrate importers. Organization branding replaces the mark through `useBranding()` (Enterprise entitlement). |
| `KortixLogo` shim | `apps/web/src/components/sidebar/kortix-logo.tsx` | `symbol`, `logomark` | Legacy re-export. New code imports the canonical file. |
| `Kortix` glyph | `apps/web/src/features/icon/icons/kortix.tsx` | size-4 symbol | A house glyph, `currentColor`. |
| `KortixHyperLogo` | `apps/web/src/components/ui/marketing/kortix-hyper-logo.tsx` | animated dissolve of the symbol | Marketing art. |
| Mobile `KortixLogo` | `apps/mobile/components/kortix/KortixLogo.tsx` | `symbol`, `logomark`, `text` | `color="dark"` renders the white file: the prop names the surface, not the ink. |
| `MetalKortixLogo` | `apps/mobile/components/kortix/MetalKortixLogo.tsx` | Skia metal symbol | Mobile hero art. |

## The symbol has three proportions

**Rule.** Treat the `Brandmark Black.svg` file as the master symbol. Derive every other symbol copy from it. — *Why:* the symbol exists in three width-to-height ratios across the repo. The brand kit master and the lockup's symbol measure 1.167. The mobile and favicon files measure 1.18. `kortix-symbol.svg` measures 1.195. The product UI draws the 1.195 version, and it is inlined in five source files (`kortix-logo.tsx`, `kortix-hyper-logo.tsx`, `icons/kortix.tsx`, `system-fault.tsx`, mobile `mark-math.ts`). App icons measure about 1.164 to 1.171, so they match the master and not the UI (`assets` audit, bbox measurement). — *Where:* all surfaces. — *When silent:* take the file from `brandkit/`. Do not copy the inline path from a component. Re-exporting `kortix-symbol.svg` and the mobile files from the master is an open cleanup (`decisions.md`).

## Using the mark

**Rule.** Composite the file. Never generate, redraw, restyle, stretch, rotate or substitute the mark. — *Why:* image models invent a wrong shape, and a redrawn mark drifts from the master. — *Where:* all surfaces, especially image. — *When silent:* if no file is at hand, take it from `brandkit/`. If you cannot, ask. Do not draw a stand-in. The CSS-drawn "K" tile on the public proxy pages is a bug, not a precedent.

**Rule.** Show one mark per surface. — *Why:* competing logos break the same placement discipline as competing accents (D6). `kortix-image` used to ask for a small corner logo plus a large central logo. That is two marks and is retired. — *Where:* all surfaces. — *When silent:* choose the symbol or the logo, one place. A product screenshot that shows the in-app mark inside the UI does not count as a second mark.

**Rule.** Choose the file by the surface color, not by recoloring. On a light surface use the black file. On a dark surface use the white file. Never put the white mark on a light surface. In code, `KortixLogo` takes `currentColor`, so set the text token (`text-foreground`, or `text-primary-foreground` on a `bg-primary` fill). — *Why:* the brand kit files are pure black and pure white, so the mark has two states. `kit-drift` found four different ink values in four sources. — *Where:* all surfaces. — *When silent:* black or white. Recoloring means picking the other file. Mobile has a recolor palette sheet for `MetalKortixLogo`; that is a shader treatment, not a license to recolor elsewhere.

**Rule.** Use the symbol alone on 16:9 layouts (slides, covers), top-left. Use the logo only when a layout needs the wordmark or someone asks for it. — *Why:* the symbol keeps the cover quiet. — *Where:* deck, image. — *When silent:* symbol, top-left.

**Rule.** Allowed treatments of the symbol are: the file as is; `currentColor`; the pixel/dither mark (`graphic-elements.md`); the hyper-logo dissolve on marketing; the mobile metal shader. — *Why:* each is a shipped, reviewed treatment. — *Where:* as named. — *When silent:* the file as is.

**Rule.** Paint the mark once and hold it across navigations. An account brand icon replaces it through `useBranding()`. — *Why:* sign-in paints one mark across three navigations instead of flashing four frames (#7179, #7263). — *Where:* app. — *When silent:* `ProjectPendingScreen`.

**Rule.** Size the symbol by height with its real aspect ratio. A square box adds about 8% padding above and below. — *Why:* `KortixLogo` `icon` draws a 30 by 25 mark into a square box, and `provider-branding.tsx` adds a special-case inset for it. — *Where:* app. — *When silent:* pass `size` as the height and let the width follow.

**Rule.** A page that cannot load a file (a CSP with `default-src 'none'`, a proxy page) inlines the path data of `Brandmark Black.svg` with `fill="currentColor"` and sizes it by height. Do not copy the inline path from a component. — *Why:* the master file is the one shape, and the components inline three different proportions (above). A CSS-drawn "K" is a bug (Q35). — *Where:* any HTML outside `apps/web`. — *When silent:* `cat` the file, copy its `d` attribute, set `height`, and let the width follow.

## Do not

- Do not generate, redraw or restyle the mark.
- Do not stretch, rotate, crop or outline it.
- Do not put it on a busy photo or on a surface with weak contrast.
- Do not add a drop shadow, a glow, a gradient fill or an effect (the GitHub social preview's gradient wordmark breaks this).
- Do not place two Kortix marks on one surface.
- Do not retype the wordmark as text, in bold or in any font.
- Do not put the Kortix mark on customer output. Whether agent-built customer sites may carry a Kortix generator or author meta tag is OPEN (`decisions.md`, D8c).

## Clear space and minimum size

**OPEN (D8b).** No document defines clear space around the symbol or the logo. No document defines a minimum size for web or print. The only recorded numbers are mobile: the hero symbol is 30% of the screen width, with a minimum of 88pt and a maximum of 150pt (`apps/mobile/design.md`). Do not invent numbers. Shipped sizes today: the marketing nav logo is `size={15}` and the nav symbol `size={14}` (`components/home/navbar.tsx`), the email logo is `--email-logo-height` in `tokens.css`, and the mobile hero is 88 to 150pt. When silent: reuse a size and a margin that already ships (the nav logo, the sidebar symbol, the deck cover), never go smaller than the smallest shipped use, and ask the design lead. Record the decision in `decisions.md` when it is made.

## Surface placement

| | app | marketing | mobile | deck | image | email | CLI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Mark | `KortixLogo` | symbol or logo in the nav; one hero mark at most | `KortixLogo`; hero symbol 88 to 150pt | symbol, top-left | one mark, composited | logo PNG, hosted | ASCII wordmark: OPEN |
| Light | black file or `currentColor` | same | `color` prop picks the file | follow the theme | by background | black PNG | n/a |
| Dark | white file or `currentColor` | same | same | same | white file | n/a: email ships light only (Q34) | n/a |

The email wordmark is the logo PNG, hosted, not bold text. The CLI banner is a block-letter ASCII "KORTIX" with the tagline. It ignores `NO_COLOR` today, and the same art ships inside customer-site templates. Whether the ASCII wordmark is a sanctioned treatment is OPEN (`decisions.md`).

## App icons, favicons, share images

**Shipped on this branch (2026-10-01, measured with `sips` and pixel sampling).** A design lead confirms the tile and the scale: they are the shipped values, not a reviewed decision (Q39, OPEN).

| File (`apps/web/public/`) | Size | Tile | Symbol | Symbol scale |
| --- | --- | --- | --- | --- |
| `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` (180) | 192, 512, 180 | `--background` (dark) | white file | about 58% of the width, 50% of the height |
| `icon-maskable-512.png` | 512 | `--background` (dark) | white file | about 44% of the width, 38% of the height, inside the 80% safe zone |
| `icon-dark-32.png` | 32 | `--background` (dark) | white file | about 72% of the width |
| `icon-light-32.png`, `favicon.ico` (48) | 32, 48 | `--background` (light) | black file | about 71% of the width |

Every file is opaque (no alpha) and keeps the master ratio of about 1.167. `[locale]/layout.tsx` links `favicon.ico` (any), `icon-light-32.png` and `icon-dark-32.png` by `prefers-color-scheme`, and `apple-touch-icon.png`. `manifest.json` lists the three large PNGs. — *Rule.* Regenerate an icon from the master symbol on the tile above. Do not hand-edit a PNG, and do not take the symbol from `favicon.svg`. — *Why:* the old icons mixed a dark mark on a light tile, a black mark on a warm tile and a white mark on a gradient squircle (Q39). — *Where:* app, marketing. — *When silent:* these files.

**OPEN (Q39).** `manifest.json` `background_color` and `theme_color` are `#000000`, and the viewport `themeColor` pair is `white` and `black`. The dark canvas is the `--background` token (a near-black), so the splash and the browser chrome differ from the app by a few percent. A person confirms whether to align them to the token. The desktop and mobile icons keep their own artwork: one icon spec across all four is still OPEN.

## Rationalization table

| Thought | Reality |
| --- | --- |
| "I will redraw the symbol so it fits the layout" | Composite the file. A redrawn mark drifts from the master. |
| "A corner logo and a large logo both help" | One mark per surface. |
| "The white symbol is fine on this light card" | The mark has two states. Pick the file by the surface. |

## Email

**Rule.** Host the email logo at the URL in `visual-system.json` (`email.logo_url`), which `template.ts` reads as `EMAIL_LAYOUT.logoUrl`: `https://kortix.com/brandkit/Logo/Logomark/PNG/Logomark%20Black.png`. Set `height` from `--email-logo-height` in `tokens.css`. Ship the black PNG only, on the light card. — *Why:* email clients cannot read CSS variables, and the logo is the lockup asset (symbol and wordmark in one PNG), so there is no separate wordmark file. Verified with `curl` on 2026-10-01: the URL returns 200 `image/png`, and so do `Logomark%20White.png` and `Brandmark%20Black.svg` at the same host. Email ships light only, so the earlier two-logo swap is superseded (Q34, Q10, Q27). — *Where:* email. — *When silent:* the URL above, one logo.
