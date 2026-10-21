'use client';

import { threadPath, useFirm, useMatter } from '@/components/access';
import { errorText } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import { Button } from '@kortix/ui/button';
import Loading from '@kortix/ui/loading';
import { Textarea } from '@kortix/ui/textarea';
import { errorToast } from '@kortix/ui/toast';
import { ArrowUpIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import { useAction, useQuery } from 'convex/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

const SUGGESTIONS = [
  'Summarize the key risks across these agreements.',
  'Which agreements have uncapped liability?',
  'List every change-of-control clause and what it requires.',
];

/** A new question: one thread (one secure session) on Lumen's counsel agent. */
export default function NewQuestion() {
  const firm = useFirm();
  const { matter } = useMatter();
  const router = useRouter();
  const createThread = useAction(api.kortix.createThread);
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState(false);
  const ready = firm.status === 'ready';
  const docs = useQuery(api.documents.list, { matterId: matter._id });
  const readyDocs = (docs ?? []).filter((d) => d.status === 'ready').length;

  async function submit(text = prompt.trim()) {
    if (!text || pending || !ready) return;
    setPending(true);
    try {
      const t = await createThread({ matterId: matter._id, title: text, prompt: text });
      router.push(threadPath(matter._id, t.threadId));
    } catch (err) {
      setPending(false);
      errorToast('Could not start the conversation', { description: errorText(err) });
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-6 py-10">
      <h2 className="font-display text-3xl tracking-tight">Ask about {matter.name}</h2>
      <p className="mt-1 mb-5 text-sm text-muted-foreground">
        Lumen answers from this matter and cites the passage behind every claim. Each conversation runs in its own secure workspace.
      </p>
      <div className="rounded-xl border border-border bg-card shadow-sm transition-colors focus-within:border-ring motion-reduce:transition-none">
        <Textarea
          rows={3}
          minHeight={96}
          maxHeight={260}
          aria-label="Ask Lumen"
          value={prompt}
          disabled={pending || !ready}
          placeholder={ready ? 'Ask Lumen about this matter…' : 'Your workspace is still being set up…'}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          className="scrollbar-thin border-0 bg-transparent px-4 pt-3.5 leading-relaxed focus:ring-0"
        />
        <div className="flex justify-end px-3 pb-3">
          <Button size="icon-base" className="rounded-full" disabled={!prompt.trim() || pending || !ready} onClick={() => submit()} aria-label="Send">
            {pending ? <Loading className="size-4" /> : <ArrowUpIcon className="size-4" />}
          </Button>
        </div>
      </div>
      {docs && readyDocs === 0 ? (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-dashed border-border p-4" data-testid="assistant-empty-vault">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{docs.length === 0 ? 'Add documents to this matter' : 'Your documents are still processing'}</p>
            <p className="text-xs text-muted-foreground">
              {docs.length === 0
                ? 'Lumen answers from the matter’s vault. Upload contracts to get cited answers.'
                : 'Questions about them work once they are ready.'}
            </p>
          </div>
          <Button asChild size="sm" variant={docs.length === 0 ? 'default' : 'ghost'}>
            <Link href={`/app/matters/${matter._id}/vault`}>
              <UploadSimpleIcon className="size-4" /> {docs.length === 0 ? 'Upload' : 'Open vault'}
            </Link>
          </Button>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <Button
              variant="ghost"
              key={s}
              type="button"
              disabled={pending || !ready}
              onClick={() => submit(s)}
              className="h-auto rounded-full border border-border px-3 py-1.5 text-xs font-normal text-muted-foreground transition-colors hover:border-brand/40 hover:text-foreground disabled:opacity-50"
            >
              {s}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
