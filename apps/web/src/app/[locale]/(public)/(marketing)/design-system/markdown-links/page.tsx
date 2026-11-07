'use client';

import { useState } from 'react';
import { useTranslations } from '@/i18n/use-translations';
import { Button } from '@kortix/ui/button';
import { UnifiedMarkdown } from '@kortix/ui/markdown';

const EXAMPLE = `Merged https://github.com/example/project/pull/123, Follow-up: https://linear.app/example/issue/ENG-42/readable-links

Discuss in https://example.slack.com/archives/C123/p1234567890123456 or review https://www.figma.com/design/abc123/Example

Notes: https://www.notion.so/Example-0123456789abcdef0123456789abcdef and https://docs.google.com/document/d/example/edit

Profiles and repositories: https://github.com/example-user and https://github.com/example/project

Long titles wrap: https://www.notion.so/Engineering-Onboarding-Guide-for-New-Hires-2026-0123456789abcdef0123456789abcdef

Titles without spaces wrap too: [エンジニアリングの新入社員向けオンボーディングガイドと変更の確認](https://github.com/example/project/pull/123)

Custom labels stay intact: [Review the changes](https://github.com/example/project/pull/123).

Other links stay readable: https://example.com/reference
`;

export default function MarkdownLinksPage() {
  const [streaming, setStreaming] = useState(false);
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <main className="mx-auto max-w-3xl px-6 pb-12 pt-24">
      <h1 className="text-2xl font-semibold">{tI18nComplete.raw('text2e914b62b832')}</h1>
      <p className="text-muted-foreground mt-2">
        {tI18nComplete.raw('text7bed093239f3')}
      </p>
      <Button className="mt-4" variant="outline" onClick={() => setStreaming(!streaming)}>{streaming ? tI18nComplete.raw('textaf4df8fff726') : tI18nComplete.raw('textc5bb2bbce674')}</Button>
      <div className="bg-card mt-8 rounded-xl border p-6">
        <UnifiedMarkdown trust="untrusted" isStreaming={streaming} content={EXAMPLE} />
      </div>
      <p className="text-muted-foreground mt-6 text-sm">
        {tI18nComplete.raw('textfc19d1c660c8')}
      </p>
    </main>
  );
}
