"use client";

import { createGlyphSpin3Component } from "@/lib/dotmatrix-core";
import type { DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type Dotm3x3_20Props = DotMatrixCommonProps;

/** L-shaped corner — row-major 0/1 form. */
const CORNER_GLYPH = [1, 1, 0, 1, 0, 0, 1, 0, 0] as const;

export const Dotm3x3_20 = createGlyphSpin3Component("Dotm3x3_20", CORNER_GLYPH);
