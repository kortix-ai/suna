import type { Metadata } from 'next';
import { DiceStage } from './dice-stage';

export const metadata: Metadata = {
  title: 'All in one — Kortix',
  description:
    'Six layers of the agent stack on the six faces of one die. Roll it to read a face.',
};

export default function A1oPage() {
  return (
    <main className="relative h-dvh w-screen overflow-hidden bg-black">
      <DiceStage />
    </main>
  );
}
