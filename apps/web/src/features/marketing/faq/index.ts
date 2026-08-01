/**
 * The home-page FAQ. One section, mounted directly above the closing CTA:
 *
 *   … → use-case wheel → ControlSection → TrustSection → OpenSourceSection →
 *   FaqSection → CtaSection
 *
 * It is the last thing before the ask, and the only place on the page that
 * concedes anything. `faq-section.tsx` records why it is a slab and not an
 * accordion; `content.ts` carries the copy and its accuracy gate.
 */
export { FaqSection } from './faq-section';
export { faq, type FaqItem } from './content';
