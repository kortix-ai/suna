import { DemoForm } from '@/components/marketing/demo-form';
import { FIRMS } from '@/components/marketing/content';
import { FirmLockup } from '@/components/marketing/parts';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Request a demo', description: 'See Lumen on your own kind of matter.' };

export default function DemoPage() {
  return (
    <div className="grid min-h-[calc(100dvh-72px)] lg:grid-cols-2">
      <div className="pattern-laid flex flex-col justify-between gap-16 px-6 py-16 text-white md:px-16 lg:py-20">
        <h1 className="display-lg max-w-lg">Bring one matter. Watch it answered with sources.</h1>
        <div className="grid grid-cols-2 gap-x-8 gap-y-6 text-white/70 sm:grid-cols-3">
          {FIRMS.slice(0, 6).map((f) => (
            <FirmLockup key={f.name} name={f.name} style={f.style} className="text-[0.8em]" />
          ))}
        </div>
      </div>
      <div className="flex items-center px-6 py-16 md:px-16">
        <div className="mx-auto w-full max-w-[560px]">
          <h2 className="display-sm">Request a demo</h2>
          <p className="mt-4 mb-10 text-[16px] text-muted-foreground">Tell us about your team. We will show you Lumen on the kind of matter you run.</p>
          <DemoForm />
        </div>
      </div>
    </div>
  );
}
