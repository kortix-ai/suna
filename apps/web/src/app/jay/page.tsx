import { UnifiedMarkdown } from '@/components/markdown';
import { MARKDOWN_REFERENCE } from './markdown-reference';

export default function JayPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <UnifiedMarkdown content={MARKDOWN_REFERENCE} />
    </main>
  );
}
