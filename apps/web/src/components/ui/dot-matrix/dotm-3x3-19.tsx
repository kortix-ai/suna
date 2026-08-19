"use client";

import { createGlyphSpin3Component } from "@/lib/dotmatrix-core";
import type { DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type Dotm3x3_19Props = DotMatrixCommonProps;

/** Right arrow — row-major 0/1 form. */
const ARROW_GLYPH = [0, 1, 0, 0, 1, 1, 0, 1, 0] as const;

export const Dotm3x3_19 = createGlyphSpin3Component("Dotm3x3_19", ARROW_GLYPH);
