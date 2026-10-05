'use client';

import { createGlyphSpin3Component } from '@/lib/dotmatrix-core';


/** Play triangle — row-major 0/1 form. */
const PLAY_GLYPH = [1, 0, 0, 1, 1, 0, 1, 0, 0] as const;

export const Dotm3x3_21 = createGlyphSpin3Component('Dotm3x3_21', PLAY_GLYPH);
