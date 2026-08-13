"use client";

import { createDiagonalWave3Component } from "@/lib/dotmatrix-core";
import type { DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type Dotm3x3_3Props = DotMatrixCommonProps;

export const Dotm3x3_3 = createDiagonalWave3Component("Dotm3x3_3", "tl-br");
