"use client";

import { createGlyphSpin3Component } from "@/lib/dotmatrix-core";
import type { DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type Dotm3x3_18Props = DotMatrixCommonProps;

/** Checkmark — row-major 0/1 form. */
const CHECK_GLYPH = [0, 0, 1, 0, 1, 0, 1, 0, 0] as const;

export const Dotm3x3_18 = createGlyphSpin3Component("Dotm3x3_18", CHECK_GLYPH);
