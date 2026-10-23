# Kortix merch

Print artwork for Kortix merch: a card deck (54 cards plus a back), poker chip inlays, flags, posters, mugs, a mousepad, a desk mat, tote bags, t-shirts and stickers. `merch.html` draws every file. `export.mjs` renders them.

## Upload files (`upload/`)

| File | Size | Use |
| --- | --- | --- |
| `card-back.png` | 1500 x 2100 px (2.5 x 3.5 in, 600 dpi) | Card back, black. Upload this to a shop that takes one back image. |
| `card-back-white.png` | 1500 x 2100 px | Card back, white. |
| `card-back-with-bleed.png`, `card-back-white-with-bleed.png` | 1650 x 2250 px | The same backs plus 1/8 in bleed per side, for a printer that asks for bleed. |
| `chip-front.png` | 1200 x 1200 px | Chip inlay front: the symbol in a dither dot ring. White ground, black ink. |
| `chip-back.png` | 1200 x 1200 px | Chip inlay back: the pixel mark in a ring of 36 square dots. |
| `flag-black-150x105.png`, `flag-white-150x105.png` | 6000 x 4200 px (10:7, about 100 dpi at 150 cm) | Flag for the 70 x 100 cm and 105 x 150 cm sizes. |
| `flag-black-150x130.png`, `flag-white-150x130.png` | 6000 x 5200 px | Flag for the 130 x 150 cm size. |
| `poster-18x24in-black.png`, `-white.png` | 5400 x 7200 px (300 dpi) | Poster: the symbol on the dot field. |
| `mug-wrap-11oz-black.png`, `-white.png` | 2550 x 1050 px (8.5 x 3.5 in, 300 dpi) | 11 oz mug wrap. The logo sits at the center, opposite the handle. |
| `mousepad-black.png`, `-white.png` | 2775 x 2325 px (9.25 x 7.75 in, 300 dpi) | Mousepad: the symbol on the dot field. |
| `deskmat-80x40cm-black.png`, `-white.png` | 6299 x 3150 px (200 dpi) | Desk mat: the logo on the dot field. |
| `tote-12x12in-ink-black.png`, `-ink-white.png` | 3600 x 3600 px, transparent | Tote bag: the logo. `ink-black` for a natural or white bag, `ink-white` for a black bag. |
| `tee-chest-4x4in-ink-black.png`, `-ink-white.png` | 1200 x 1200 px, transparent | T-shirt or hoodie left chest: the symbol. Also the file for cap embroidery. |
| `tee-back-12x16in-ink-black.png`, `-ink-white.png` | 3600 x 4800 px, transparent | T-shirt or hoodie back: the pixel mark in a dot halo. Pair with the chest print. |
| `sticker-app-icon-3in.png` | 900 x 900 px, transparent corners | The app icon (`apps/web/public/favicon.svg`) as a sticker. |
| `sticker-pixel-3in.png` | 900 x 900 px, transparent corners | The pixel mark on a white rounded square. |
| `sticker-logo-4x1.5in.png` | 1200 x 450 px, transparent corners | The white logo on a black rounded rectangle. |

`black` / `white` name the ground color. `ink-black` / `ink-white` name the ink on a transparent ground: choose the one that contrasts with the garment or bag.

Chip inlays are white so they fit any chip body color (tested on black and sky blue mockups). All chip art stays inside the round print area, so a round crop cuts only white.

## The design

- **Back:** the symbol on a square-dot field that fades out around it through a 4 x 4 ordered dither. The symbol is 180 degree symmetric, so the back has no up or down.
- **Pips and indices:** Phosphor fill-weight suits (`@phosphor-icons/react`), indices in Roobert. Spades and clubs in ink, hearts and diamonds in `kortix-red`.
- **Ace of spades:** the symbol (`brandkit/Logo/Brandmark/SVG/Brandmark Black.svg`, composited, not redrawn).
- **Courts:** pixel crowns over each suit sampled onto a grid, in the `#` / `+` cell language of `PixelKortixMark` (`packages/ui/src/primitives/pixel-kortix-mark.tsx`).
- **Jokers:** the pixel mark. Big joker on the dark `--background`, little joker on the light one.
- **Flags:** the logo (`brandkit/Logo/Logomark/SVG/Logomark Black.svg`, path data inlined) at 62% of the width, on the card-back dot field. The field clears in a wide ellipse around the logo. One file per shape, so the shop does not crop the logo.
- **Everything else:** one function, `item()` in `merch.html`: one mark (symbol, logo or pixel mark) on the same dot field, drawn in mm and rendered at the item's dpi. A new item is one line in `SPECS`.

Colors are the `tokens.css` values, inlined in `merch.html` with their token names, because a print file cannot read CSS variables.

## Regenerate

1. Install Google Chrome and the Roobert fonts locally.
2. Run `node .agents/skills/kortix-brand/references/merch/export.mjs` from the repo root.
3. It rewrites `upload/` (27 files) and writes all 56 cards (PNG at 300 dpi with bleed) and an SVG of every item to `output/merch/` (gitignored). It takes about 2 minutes.

Open `merch.html` in a browser to see every item on one sheet.

## Open

- Clear space and minimum print size for the mark are OPEN (D8b in [decisions.md](../decisions.md)). The sizes here are a choice for this item only.
- `kortix-red` is a screen color. Check a printed proof before a large order.
