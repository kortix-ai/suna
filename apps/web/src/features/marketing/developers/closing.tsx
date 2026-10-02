import { FaqSection } from '@/features/marketing/faq/faq-section';
import { cn } from '@/lib/utils';
import { closing } from './content';
import { SECTION_HEADING } from './shared';

/** Same FAQ layout as the landing page, with developer questions. */
export function DevelopersClosing() {
  return (
    <FaqSection
      eyebrow=""
      title={closing.title}
      items={closing.faq}
      titleClassName={cn(SECTION_HEADING, 'sm:text-[1.75rem]/8')}
    />
  );
}
