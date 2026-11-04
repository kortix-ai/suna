'use client';

import { useState } from 'react';
import { Button } from '@kortix/ui/button';
import { UnifiedMarkdown } from '@kortix/ui/markdown';

const EXAMPLE = `Merged https://github.com/example/project/pull/123, Follow-up: https://linear.app/example/issue/ENG-42/readable-links

Discuss in https://example.slack.com/archives/C123/p1234567890123456 or review https://www.figma.com/design/abc123/Example

Notes: https://www.notion.so/Example-0123456789abcdef0123456789abcdef and https://docs.google.com/document/d/example/edit

Custom labels stay intact: [Review the changes](https://github.com/example/project/pull/123).

Other links stay readable: https://example.com/reference
`;

export default function MarkdownLinksPage() {
  const [streaming, setStreaming] = useState(false);
  return (
    <main className="mx-auto max-w-3xl px-6 pb-12 pt-24">
      <h1 className="text-2xl font-semibold">Markdown links</h1>
      <p className="text-muted-foreground mt-2">
        Recognised resources show an app icon and compact label. Hover to inspect the original URL.
      </p>
      <Button className="mt-4" variant="outline" onClick={() => setStreaming(!streaming)}>{streaming ? 'Finish streaming' : 'Show streaming'}</Button>
      <div className="bg-card mt-8 rounded-xl border p-6">
        <UnifiedMarkdown trust="untrusted" isStreaming={streaming} content={EXAMPLE} />
      </div>
      <p className="text-muted-foreground mt-6 text-sm">
        GitHub pull requests, issues and commits; Linear issues; Slack messages and conversations;
        Figma designs, boards and slides; Notion pages; Google Docs, Sheets and Slides. Labels use
        the URL only. Titles, permissions and live status are not fetched.
      </p>
    </main>
  );
}
