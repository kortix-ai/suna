"use client";

import { createGlyphSpin3Component } from "@/lib/dotmatrix-core";
import type { DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type Dotm3x3_16Props = DotMatrixCommonProps;

/** Smiley — eyes and mouth in row-major 0/1 form. */
const SMILEY_GLYPH = [1, 0, 1, 0, 0, 0, 0, 1, 0] as const;

export const Dotm3x3_16 = createGlyphSpin3Component("Dotm3x3_16", SMILEY_GLYPH);
