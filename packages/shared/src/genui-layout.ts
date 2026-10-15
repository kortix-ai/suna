/**
 * Generative-UI layout math shared by web and mobile: masonry placement, how a Card image is framed, and
 * whether a set of Cards shows as a grid or a list. Pure, so both hosts make the same decision.
 */

/** Height over width of a tile whose image has not loaded yet, and of the "+N" tile. */
export const UNKNOWN_RATIO = 3 / 4;

/**
 * Masonry placement: each tile, in order, goes into the column that is shorter so far (heights as
 * height-over-width ratios, so the column width cancels out). Ties go left. Returns tile indexes per column.
 */
export function masonryColumns(ratios: number[], columns = 2): number[][] {
  const placed: number[][] = Array.from({ length: columns }, () => []);
  const heights = new Array<number>(columns).fill(0);
  ratios.forEach((ratio, i) => {
    const column = heights.indexOf(Math.min(...heights));
    placed[column]!.push(i);
    heights[column]! += ratio;
  });
  return placed;
}

/** Height over width a card photo may take: wider than 16:9 or taller than 3:4 shows whole on the muted well. */
const CARD_RATIO_MIN = 9 / 16;
const CARD_RATIO_MAX = 4 / 3;
/** The share of a photo that may be cropped to fill its tile instead of showing bars. */
const CARD_CROP_MAX = 0.08;
/** An image narrower than this (in source pixels) is a logo or icon: a square tile, shown whole with room around it. */
const LOGO_MAX_WIDTH = 240;
/** An exactly square image up to this width is a brand logo or app icon too; a larger square image is a photo. */
const SQUARE_LOGO_MAX_WIDTH = 512;
/** The text under a photo, as a share of the column width, for balancing the columns before it is measured. */
export const CARD_TEXT_RATIO = 0.5;
export type CardShape = { ratio: number; fit: 'cover' | 'contain'; inset: boolean };

/** How a card image is framed, from its natural size: an inset square for a logo, else a photo at its own shape within the limits. */
export function cardImageShape(width: number, height: number): CardShape {
  if (!width || !height) return { ratio: UNKNOWN_RATIO, fit: 'cover', inset: false };
  const natural = height / width;
  if (width < LOGO_MAX_WIDTH || (width === height && width <= SQUARE_LOGO_MAX_WIDTH)) return { ratio: 1, fit: 'contain', inset: true };
  const ratio = Math.min(CARD_RATIO_MAX, Math.max(CARD_RATIO_MIN, natural));
  // Within CARD_CROP_MAX of the limit, filling the tile crops less than the bars `contain` would leave.
  return { ratio, fit: Math.abs(ratio - natural) / natural <= CARD_CROP_MAX ? 'cover' : 'contain', inset: false };
}

/** Grid or list for a set of Cards: the model's choice wins; otherwise a grid when most loaded images are photos. */
export function cardListLayout(hint: 'list' | 'grid' | undefined, shapes: CardShape[]): 'list' | 'grid' {
  if (hint) return hint;
  const photos = shapes.filter((shape) => !shape.inset).length;
  return photos > shapes.length - photos ? 'grid' : 'list';
}

