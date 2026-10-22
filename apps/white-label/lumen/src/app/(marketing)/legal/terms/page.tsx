import { LegalDoc } from '@/components/marketing/legal-doc';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Terms of use' };

export default function TermsPage() {
  return (
    <LegalDoc
      title="Terms of use"
      updated="October 21, 2026"
      sections={[
        { heading: 'The service', body: ['Lumen is software that helps legal professionals review, research and draft. It produces analysis for a qualified lawyer to review. It does not give legal advice.'] },
        { heading: 'Your account', body: ['Your firm administrator controls who can use Lumen for your firm, and what they can see. Keep your sign-in details private.'] },
        { heading: 'Your content', body: ['Your firm owns the documents and results it puts into or gets out of Lumen. You give us permission to process them only to provide the service.'] },
        { heading: 'Acceptable use', body: ['Do not use Lumen to break the law, to infringe others’ rights, or to try to reach another firm’s data.'] },
        { heading: 'Fees', body: ['Paid plans are charged per seat, as shown at checkout. A free trial converts only when an administrator chooses a plan.'] },
        { heading: 'Liability', body: ['Check every result before you rely on it. Lumen marks citations it could not verify, but the professional judgment is yours.'] },
        { heading: 'Changes', body: ['We may update these terms. We will tell administrators before a material change takes effect.'] },
      ]}
    />
  );
}
