import { LegalDoc } from '@/components/marketing/legal-doc';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Privacy notice' };

export default function PrivacyPage() {
  return (
    <LegalDoc
      title="Privacy notice"
      updated="October 21, 2026"
      sections={[
        { heading: 'Who we are', body: ['Lumen provides an AI workspace for legal teams. This notice explains what we collect when you use the website and the product, and why.'] },
        {
          heading: 'What we collect',
          body: [
            'Account data: your name, email address and the firm you belong to.',
            'Firm content: the documents, questions, results and settings your firm puts into Lumen. This content belongs to your firm.',
            'Usage data: which features are used and when, to run, secure and bill the service.',
          ],
        },
        { heading: 'How we use it', body: ['To provide the service your firm asked for, to keep it secure, to bill for seats, and to answer your requests. We do not sell personal data.'] },
        { heading: 'Model providers', body: ['Firm content is sent to model providers only to produce the answers and results you ask for. This deployment routes to providers that do not train on submitted content.'] },
        { heading: 'Retention', body: ['Firm content stays until your firm deletes it or closes its account. The audit log is kept for the life of the account.'] },
        { heading: 'Your rights', body: ['You can ask for a copy of your personal data, ask us to correct it, or ask us to delete it. Your firm administrator can export firm records from Settings.'] },
        { heading: 'Contact', body: ['privacy@lumen.example'] },
      ]}
    />
  );
}
