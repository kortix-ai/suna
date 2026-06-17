import type { Metadata } from 'next';
import { GameOfLife } from './game-of-life';

export const metadata: Metadata = {
  title: 'Game of Life — Kortix',
  description: "Conway's Game of Life, seeded from the Kortix logo.",
  robots: { index: false, follow: false },
};

export default function GameOfLifePage() {
  return (
    <main className="relative h-screen w-screen overflow-hidden bg-white">
      <GameOfLife />
    </main>
  );
}
