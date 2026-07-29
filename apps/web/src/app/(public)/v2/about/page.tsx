'use client';

import { CtaBand, sectionById, sectionsById } from '@/features/marketing/v2/commercial';
import { PageSection } from '@/features/marketing/v2/page-kit';
import { PAGES } from '@/features/marketing/v2/pages-content';
import { Pill } from '@/features/marketing/v2/primitives';

const ABOUT = PAGES.about;

export default function AboutPage() {
  const closing = sectionById(ABOUT, 'cta');

  return (
    <main className="bg-background">
      {sectionsById(ABOUT, 'hero', 'beliefs', 'mission').map((section) => (
        <PageSection key={section.id} section={section} />
      ))}

      {closing && (
        <CtaBand id={closing.id} heading={closing.heading} body={closing.body}>
          <Pill as="a" href="/v2/careers">
            See careers
          </Pill>
          <Pill as="a" href="https://github.com/kortix-ai/suna" variant="soft">
            Read the code
          </Pill>
        </CtaBand>
      )}
    </main>
  );
}
