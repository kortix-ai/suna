import { FaqSection } from '@/features/marketing/faq/faq-section';
import { localizedDevelopersCopy } from './content';
import { useTranslations } from '@/i18n/use-translations';
import { SECTION_HEADING } from './shared';

/** Same FAQ layout as the landing page, with developer questions. */
export function DevelopersClosing() {
  const { closing } = localizedDevelopersCopy(useTranslations('hardcodedUi.i18nComplete'));
  return (
    <FaqSection
      eyebrow=""
      title={closing.title}
      items={closing.faq}
      titleClassName={SECTION_HEADING}
    />
  );
}
