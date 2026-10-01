# Graphic elements

The shapes, marks and art that make a Kortix surface read as Kortix, beyond type and color. Each entry says what it means, where it may appear, and which file owns it. The brand mark itself is in `brandmark.md`. Imagery for posts and covers is in `art-direction.md`.

## The art layer (D4d)

Art is a sanctioned layer of the system. It is the only layer where raw color, gradients and WebGL are legal. Everything outside it follows `color.md` and `effects.md`.

**Rule.** Keep raw hex, rgb and gradients inside an art module. — *Why:* art needs exact colors that no semantic token carries (beams, dither tones, grain). Confining them to named modules lets the audit stay strict everywhere else (#8491, #7337, #6426). — *Where:* app, marketing, mobile. The audit skips the files named in `ART_RE` in `scripts/audit.sh`. — *When silent:* if you need a color the tokens lack, you are not in an art module. Use a token, or build the art in a module and add the file to `ART_RE` and to this file.

**Rule.** Make an art pane dark in both themes (the `dark` class on the art container). — *Why:* the art is drawn for a dark ground, and it must look the same in light mode (#8491). — *Where:* app, marketing. — *When silent:* dark.

**Rule.** Paint a static or SVG fallback before WebGL. — *Why:* "an SVG so it paints before (and without) WebGL2". A blank pane flashes while the shader compiles, and some devices have no WebGL (`BEAMS_IMAGE`, `ShaderSafe`). — *Where:* app, marketing. — *When silent:* ship the fallback in the same change.

**Rule.** Mark art `aria-hidden`, and let the adjacent text carry the meaning. — *Why:* art is decoration. — *Where:* all. — *When silent:* `aria-hidden="true"`.

**Rule.** Cap shader cost: `maxPixelCount` renders at most about 2 million pixels and upscales in CSS (`MAX_PIXEL_COUNT`). Pass a higher value only for a still-image export. Respect `reduceMotion`. — *Why:* GPU cost on large, high-DPR displays. — *Where:* app. — *When silent:* inherit the default.

**Rule.** Never put art behind a data panel, a table or text that the user must read at length. — *Why:* art competes with legibility, which is priority 1. — *Where:* app. — *When silent:* put art in a separate pane (split modal), a marketing card, a first-run empty or a loading mark.

## Elements

### Paper shaders: Grain, Neuro, Beams

- **What:** `GrainShader` (a soft banded gradient with a fine film-grain finish), `NeuroShader` (neuro-noise) and `BeamsShader` (light beams through grained paper, then four crisp 1px hairlines at fixed percent positions) in `apps/web/src/components/ui/paper-wallpaper-shaders.tsx`. Built on `@paper-design/shaders-react`, single-pass WebGL2.
- **Where:** Beams on the art pane of the connect modal (`features/tunnel/computer-connect.tsx`) and on the `/download` card (`features/marketing/download/card-images.tsx`). Grain and Neuro as wallpapers.
- **Not:** inside a data panel. Beams is static. It does not animate.
- **Mobile:** metal and dither shaders (`apps/mobile/lib/effects/`, `dithering-sksl.ts`, `heatmap-sksl.ts`).

### Wallpapers

- **What:** the user-selectable page backdrop. The registry is `apps/web/src/lib/wallpapers.ts`. Ids: `dither` (the default), `brandmark` (the outline wallpaper, "brandmark-bg"), `nebula` (display name "Pixel Beams"), `silk`, `grain`, `neuro`, `blank`.
- **Where:** `components/ui/wallpaper-background.tsx` renders it. Thumbnails are `apps/web/public/wallpapers/<id>-{dark,light}.jpg`. Downloads are `apps/web/public/wallpapers/downloads/kortix-<id>-{dark,light}-*`.
- **Note:** a wallpaper follows the theme, unlike an art pane. Its picker thumbnails are per theme.
- **Rename pending:** the wallpaper id `brandmark` collides with D6 ("brandmark" is retired for the symbol). OPEN in `decisions.md`.

### Pixel and dither Kortix mark

- **What:** the symbol sampled onto a 12 by 10 grid. `#` is a full cell and `+` is a partial cell drawn as a checker, so the curves read as dither (`apps/web/src/components/ui/pixel-kortix-mark.tsx`, `PixelKortixMark`). It is `aria-hidden` and uses `currentColor`.
- **Where:** a first-run empty state, with one muted line below it (#7337: "Sessions you start will show up here"). Mobile has the same idea as a pixel flower (`apps/mobile/components/kortix/PixelDeadFlower.tsx`).
- **Not:** as a logo substitute. It is art, not the brand mark.

### Dot-matrix busy glyphs

- **What:** a family of small dot-grid animations (`apps/web/src/components/ui/dot-matrix/`). `SessionDotMatrix` hashes the `session_id` (FNV-1a) onto one variant. The choice is random across sessions and stable within one: the same session shows the same glyph on every render and device. The catalog holds the 3x3, circular and square families only. Hex and triangle are out because they read poorly at 14px. Append new variants inside their family so existing sessions keep their glyph. Default with no `sessionId`: `DotmSquare14`. `/debug/dot-matrix` renders the catalog.
- **Where:** session-scoped busy states: the session list, an approve or deny button while a decision saves (D4f, #8421).
- **Not:** a general spinner. `Loading` is the spinner for everything else. Spinning icons stay banned.

### Kortix asterisk

- **What:** a four-arm asterisk bullet (`apps/web/src/components/ui/kortix-asterisk.tsx`). `variant="gradient"` runs through the accents (`KORTIX_BULLET_GRADIENT`). `variant="solid"` is one color.
- **Where:** marketing lists and deck bullets (`presentations/engine/parts.tsx`).
- **Not:** in app chrome, and not as a loader. Do not spin it (D4f bans spinning icons). Use the `kortix-bullet-flow` animation when it must move. Existing `animate-spin` uses on marketing pages are debt.

### Hyper-logo dissolve

- **What:** an animated 72-cell dissolve of the symbol (`components/ui/marketing/kortix-hyper-logo.tsx`).
- **Where:** marketing hero only, once per viewport.

### Handshake

- **What:** two same-size tiles joined by a dotted bridge: Kortix, then the app. A green check sits on the app corner when connected. The title names the app: "Connect {App} to {Project}". Never a generic plug (`components/setup-links/connector-handshake.tsx`, #7660, #8421). Mobile: `apps/mobile/components/session/connector-handshake.tsx`.
- **Rules:** the Kortix tile is the page surface plus a hairline. The app tile is white in both themes through a named constant. Below 28rem the app logo leads alone (container query). See `color.md`.

### Glyph face (project and entity glyphs)

- **What:** the catalogue glyph that identifies a project or entity, drawn in the app's icon weight (`apps/web/src/components/ui/glyph-face.tsx`, `glyphFace(name)`). The color palette is `color.glyph.*`, chosen by the user, and it clears 3:1 against the fill. The picker loads the full registry (`glyph-picker.tsx`). The avatar loads only the one path.
- **Where:** `EntityAvatar`, project tiles.
- **Not:** the Kortix mark. An account brand icon (`useBranding()`) replaces the mark, not the glyph.

### Liquid glass

- **What:** a frosted secondary surface. Tokens are `effects.liquid-glass`. Only through its utility.
- **Where:** over imagery or a wallpaper only. Do not use it in flow.

### Grain texture

- **What:** `apps/web/public/grain-texture.png`, a film-grain overlay used by `animated-bg.tsx`, `blog-cover.tsx` and `use-cases/covers.tsx`.
- **Where:** marketing covers.

## House icon set (D4i)

**Rule.** Use `@phosphor-icons/react` as the icon library. Use `apps/web/src/features/icon/icons` as the house glyph set for shapes Phosphor lacks. — *Why:* one icon family reads as one product. The house set holds a filled check, download, a filled home, the sidebar toggle, copy, close, plus, monitor, sun, moon and the Kortix symbol glyph. — *Where:* app. Mobile uses `@/lib/icons` (`apps/mobile/AGENTS.md`). — *When silent:* look for the Phosphor icon. Only if none fits, add a house glyph.

**Rule.** Draw a house glyph in `currentColor`, sized by `className`. — *Why:* the glyph then follows the text token and the theme. — *Where:* app. — *When silent:* never set a fill.

**Rule.** When you add a house glyph, replace every Phosphor equivalent in the app in the same change. — *Why:* two download icons in one app read as an error (`download.tsx` replaced every Phosphor download icon, #8491). — *Where:* app. — *When silent:* `rg` for the Phosphor name and replace all hits.

**Rule.** Keep third-party marks in the same folder (`slack`, `github`, `gmail`, `notion` and the rest) with their own brand colors. Do not edit them. — *Why:* they are not Kortix's to recolor. The audit skips them by name (`LOGO_RE`). — *Where:* app. — *When silent:* draw a third-party mark on the white logo tile.

**Rule.** Do not use emoji as UI iconography. Do not import lucide or react-icons. — *Why:* emoji render per platform. A second library breaks the family. — *Where:* app, mobile. Emoji is a user's choice in the emoji picker, and chat surfaces follow `verbal/voice-and-tone.md`. — *When silent:* Phosphor.

## Per surface

| | app | marketing | mobile | deck | image | email | CLI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Art layer | split-modal pane, first-run, loading | cards, covers, hero | `KortixCurrents` hero, metal logo, pixel flower | `KortixAsterisk` bullets, real screenshots | one art style per image | none | none |
| Beams, Grain, Neuro | art pane only | cards | mobile shaders instead | none | rendered stills are allowed as backgrounds | none | none |
| Dot matrix | session busy | none | `KortixLoader` | none | none | none | none |
| Wallpaper | project backdrop | `/download` wallpapers | none | none | none | none | none |
| Icon set | Phosphor + house set | same | `@/lib/icons` | Phosphor | one icon family | none | plain text; no emoji |

## Rationalization table

| Thought | Reality |
| --- | --- |
| "A shader behind this table would look rich" | Art competes with legibility. Put it in its own pane. |
| "I will inline a hex just for this gradient" | Only inside an art module. Otherwise use a token. |
| "A spinning asterisk is on brand" | Spinning icons are banned. The asterisk is a bullet. |
| "I will draw a new icon for download" | Replace every Phosphor equivalent in the same change, or use the Phosphor icon. |
| "Dot matrix is a fun spinner for this page" | `Loading` is the spinner. Dot matrix marks session-scoped work. |

