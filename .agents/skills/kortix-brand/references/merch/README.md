# Kortix merch

Print artwork for a Kortix card deck (54 cards plus a back), poker chip inlays and flags. `merch.html` draws every file. `export.mjs` renders them.

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

Chip inlays are white so they fit any chip body color (tested on black and sky blue mockups). All chip art stays inside the round print area, so a round crop cuts only white.

## The design

- **Back:** the symbol on a square-dot field that fades out around it through a 4 x 4 ordered dither. The symbol is 180 degree symmetric, so the back has no up or down.
- **Pips and indices:** Phosphor fill-weight suits (`@phosphor-icons/react`), indices in Roobert. Spades and clubs in ink, hearts and diamonds in `kortix-red`.
- **Ace of spades:** the symbol (`brandkit/Logo/Brandmark/SVG/Brandmark Black.svg`, composited, not redrawn).
- **Courts:** pixel crowns over each suit sampled onto a grid, in the `#` / `+` cell language of `PixelKortixMark` (`packages/ui/src/primitives/pixel-kortix-mark.tsx`).
- **Jokers:** the pixel mark. Big joker on the dark `--background`, little joker on the light one.
- **Flags:** the logo (`brandkit/Logo/Logomark/SVG/Logomark Black.svg`, path data inlined) at 62% of the width, on the card-back dot field. The field clears in a wide ellipse around the logo. One file per shape, so the shop does not crop the logo.

Colors are the `tokens.css` values, inlined in `merch.html` with their token names, because a print file cannot read CSS variables.

## Regenerate

1. Install Google Chrome and the Roobert fonts locally.
2. Run `node .agents/skills/kortix-brand/references/merch/export.mjs` from the repo root.
3. It rewrites `upload/` and writes all 56 cards (PNG at 300 dpi with bleed) and an SVG of every item to `output/merch/` (gitignored).

Open `merch.html` in a browser to see every item on one sheet.

## Open

- Clear space and minimum print size for the mark are OPEN (D8b in [decisions.md](../decisions.md)). The sizes here are a choice for this item only.
- `kortix-red` is a screen color. Check a printed proof before a large order.
