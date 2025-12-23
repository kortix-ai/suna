'use client';

import dynamic from 'next/dynamic';
import React from 'react';

// Dynamically import react-konva components with no SSR
export const Stage = dynamic(
  () => import('react-konva').then((mod) => mod.Stage),
  { ssr: false }
);

export const Layer = dynamic(
  () => import('react-konva').then((mod) => mod.Layer),
  { ssr: false }
);

export const KonvaImage = dynamic(
  () => import('react-konva').then((mod) => mod.Image),
  { ssr: false }
);

export const Transformer = dynamic(
  () => import('react-konva').then((mod) => mod.Transformer),
  { ssr: false }
);

