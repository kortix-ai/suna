'use client';

import { useTranslations } from '@/i18n/use-translations';

import { useParams } from 'next/navigation';
import { SharePageWrapper } from './_components/SharePageWrapper';
import { ShareViewer } from './_components/ShareViewer';

export default function SharePage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const params = useParams();
  const shareId = params?.shareId as string;

  if (!shareId) {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">
          {tHardcodedUi.raw('appShareShareidPage.line15JsxTextInvalidShareLink')}
        </p>
      </div>
    );
  }

  return (
    <SharePageWrapper>
      <ShareViewer shareId={shareId} />
    </SharePageWrapper>
  );
}
