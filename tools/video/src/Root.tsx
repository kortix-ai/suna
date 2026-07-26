import React from 'react';
import { Composition } from 'remotion';
import { Sizzle, TOTAL_FRAMES } from './Sizzle';
import { FPS, HEIGHT, WIDTH } from './theme';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Sizzle"
    component={Sizzle}
    durationInFrames={TOTAL_FRAMES}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
  />
);
