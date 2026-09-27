/**
 * The grain texture every trust seal fills its inner disc with.
 *
 * The three seals once embedded this 800x800 PNG as a 73.5 KB base64 data URI
 * each. The seals are client components on a client page, so every copy
 * shipped twice (in the SSR HTML and in the page chunk): ~440 KB of the same
 * bytes on `/`. As a static file it downloads once, is cached, and is shared by
 * all three seals. An inline <svg> may reference an external image; an <img
 * src="*.svg"> could not, which is why the seals stay inline.
 */
export const SEAL_TEXTURE_SRC = '/marketing/trust/seal-texture.png';
