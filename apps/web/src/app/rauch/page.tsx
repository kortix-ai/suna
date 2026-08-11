import type { Metadata } from 'next';
import { doscoParticleMark } from './kortix-particle-mark';

export const metadata: Metadata = {
  title: 'Particle Mark — dosco',
  description: 'A Rauch-style hard-pixel particle rendering of the dosco symbol.',
  robots: { index: false, follow: false },
};

export default function RauchPage() {
  return (
    <main className="fixed inset-0 overflow-hidden bg-background">
      <doscoParticleMark />
    </main>
  );
}
