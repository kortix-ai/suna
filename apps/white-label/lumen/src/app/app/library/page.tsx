'use client';

import { useFirm } from '@/components/access';
import { useLibrary } from '@/components/workflows/use-library';
import { isAdmin } from '@/lib/roles';
import { errorText, relativeTime } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { cn } from '@kortix/ui';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import Loading from '@kortix/ui/loading';
import { UnifiedMarkdown } from '@kortix/ui/markdown';
import { Skeleton } from '@kortix/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@kortix/ui/tabs';
import { Textarea } from '@kortix/ui/textarea';
import { errorToast, successToast } from '@kortix/ui/toast';
import { BookOpenTextIcon, ListChecksIcon, PenNibIcon, PlusIcon } from '@phosphor-icons/react';
import { useMutation } from 'convex/react';
import { useEffect, useState } from 'react';

type Kind = 'playbook' | 'template';
const STARTER: Record<Kind, string> = {
  playbook: '# New playbook\n\n## Rule R-01: <title>\nPosition: <the firm position>\nFallback: <what the firm accepts>\nSeverity if missed: high\n',
  template: '# New template\n\nThis agreement is made on {{effective_date}} between {{party_a}} and {{party_b}}.\n',
};

export default function LibraryPage() {
  const firm = useFirm();
  const items = useLibrary();
  const save = useMutation(api.library.save);
  const admin = isAdmin(firm.role);
  const [selected, setSelected] = useState<Id<'libraryItems'> | 'new-playbook' | 'new-template' | null>(null);
  const item = items?.find((i) => i._id === selected);
  const creating = selected === 'new-playbook' || selected === 'new-template' ? (selected.slice(4) as Kind) : null;
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!selected && items?.length) setSelected(items[0]._id);
  }, [items, selected]);
  useEffect(() => {
    if (item) {
      setName(item.name);
      setBody(item.body);
    } else if (creating) {
      setName(creating === 'playbook' ? 'New playbook' : 'New template');
      setBody(STARTER[creating]);
    }
  }, [item?._id, item?.updatedAt, creating]); // eslint-disable-line react-hooks/exhaustive-deps

  const kind: Kind | null = item?.kind ?? creating;
  const dirty = !!item && (name !== item.name || body !== item.body);

  async function submit() {
    if (!kind) return;
    setPending(true);
    try {
      const id = await save({ firmId: firm._id, itemId: item?._id, kind, name, body });
      successToast(item ? 'Saved. The next run uses this version.' : 'Created');
      setSelected(id);
    } catch (err) {
      errorToast('Could not save', { description: errorText(err) });
    } finally {
      setPending(false);
    }
  }

  const group = (k: Kind) => items?.filter((i) => i.kind === k) ?? [];
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-5 px-4 py-6 sm:px-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="space-y-5">
        <div>
          <h1 className="font-display text-2xl tracking-tight">Library</h1>
          <p className="mt-1 text-xs text-muted-foreground">The firm’s playbooks and templates. Workflows read the version current when they start.</p>
        </div>
        {items === undefined ? (
          <div className="space-y-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : (
          (['playbook', 'template'] as const).map((k) => (
            <section key={k}>
              <div className="mb-1 flex items-center justify-between">
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{k === 'playbook' ? 'Playbooks' : 'Templates'}</h2>
                {admin && (
                  <Button size="icon" variant="ghost" className="size-6" aria-label={`New ${k}`} onClick={() => setSelected(`new-${k}`)}>
                    <PlusIcon className="size-3.5" />
                  </Button>
                )}
              </div>
              <ul className="space-y-0.5">
                {group(k).map((i) => (
                  <li key={i._id}>
                    <Button
                      variant="ghost"
                      onClick={() => setSelected(i._id)}
                      className={cn('h-auto w-full justify-start gap-2 px-2 py-1.5 text-left text-sm font-normal', selected === i._id && 'bg-muted')}
                      data-testid="library-item"
                    >
                      {k === 'playbook' ? <ListChecksIcon className="size-4 text-muted-foreground" /> : <PenNibIcon className="size-4 text-muted-foreground" />}
                      <span className="min-w-0 flex-1 truncate">{i.name}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{k === 'playbook' ? `${i.rules} rules` : `${i.fields.length} fields`}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </aside>
      <section className="min-w-0 rounded-xl border border-border bg-card">
        {!kind ? (
          <div className="grid min-h-80 place-items-center text-sm text-muted-foreground">
            <span className="flex items-center gap-2"><BookOpenTextIcon className="size-4" /> Choose a playbook or template</span>
          </div>
        ) : (
          <Tabs defaultValue={creating ? 'edit' : 'preview'} key={String(selected)}>
            <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
              {admin ? (
                <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} className="h-8 w-full min-w-0 font-medium sm:w-72" />
              ) : (
                <h2 className="text-sm font-medium">{name}</h2>
              )}
              <Badge variant="muted">{kind === 'playbook' ? 'Playbook' : 'Template'}</Badge>
              {item && <span className="text-xs text-muted-foreground">Updated {relativeTime(new Date(item.updatedAt).toISOString())}</span>}
              <TabsList className="ml-auto">
                {admin && <TabsTrigger value="edit">Edit</TabsTrigger>}
                <TabsTrigger value="preview">Preview</TabsTrigger>
              </TabsList>
              {admin && (dirty || creating) && (
                <Button size="sm" disabled={pending} onClick={submit} data-testid="library-save">
                  {pending && <Loading className="size-4" />} {creating ? 'Create' : 'Save'}
                </Button>
              )}
            </header>
            {admin && (
              <TabsContent value="edit" className="m-0">
                <Textarea
                  aria-label="Body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  className="min-h-[34rem] rounded-none border-0 font-mono text-[13px] leading-relaxed focus-visible:ring-0"
                  data-testid="library-body"
                />
                <p className="border-t border-border px-5 py-2 text-xs text-muted-foreground">
                  {kind === 'playbook'
                    ? 'One "## Rule <id>: <title>" heading per rule, then Position, Fallback and "Severity if missed: high | medium | low".'
                    : 'Fields are written {{field_name}}. The draft form asks for each one; parties and the date come from the matter.'}
                </p>
              </TabsContent>
            )}
            <TabsContent value="preview" className="m-0">
              {kind === 'playbook' && parseRules(body).length > 0 ? (
                <PlaybookRules body={body} />
              ) : (
                <article className="max-w-[72ch] p-6 text-[15px] leading-relaxed">
                  <UnifiedMarkdown content={body} trust="agent" />
                </article>
              )}
            </TabsContent>
          </Tabs>
        )}
        {!admin && <p className="border-t border-border px-5 py-2 text-xs text-muted-foreground">Owners and admins edit the firm library.</p>}
      </section>
    </div>
  );
}

type Rule = { id: string; title: string; position: string; fallback: string; severity: string };

/** The rules of a playbook: one "## Rule <id>: <title>" section each, with Position, Fallback and Severity lines. */
function parseRules(body: string): Rule[] {
  return body
    .split(/^## Rule /m)
    .slice(1)
    .map((section) => {
      const [head, ...lines] = section.split('\n');
      const field = (label: string) => lines.find((l) => l.startsWith(`${label}:`))?.slice(label.length + 1).trim() ?? '';
      const [id, ...title] = head.split(':');
      return { id: id.trim(), title: title.join(':').trim(), position: field('Position'), fallback: field('Fallback'), severity: field('Severity if missed') };
    });
}

const SEVERITY_TONE: Record<string, string> = { high: 'text-risk', medium: 'text-flag', low: 'text-muted-foreground' };

function PlaybookRules({ body }: { body: string }) {
  const intro = body.split(/^## Rule /m)[0].replace(/^# .*$/m, '').trim();
  return (
    <div className="p-6">
      {intro && <p className="max-w-[72ch] text-[15px] leading-relaxed text-muted-foreground">{intro}</p>}
      <ol className="mt-4 divide-y divide-border border-y border-border" data-testid="playbook-rules">
        {parseRules(body).map((r) => (
          <li key={r.id} className="grid gap-x-6 gap-y-1 py-4 md:grid-cols-[7rem_minmax(0,1fr)_5rem]">
            <span className="font-mono text-[12px] text-muted-foreground">{r.id}</span>
            <div className="min-w-0 space-y-1.5">
              <p className="text-sm font-medium">{r.title}</p>
              <p className="text-[13px] leading-relaxed"><span className="text-muted-foreground">Position </span>{r.position}</p>
              <p className="text-[13px] leading-relaxed"><span className="text-muted-foreground">Fallback </span>{r.fallback}</p>
            </div>
            <span className={cn('text-[13px] capitalize md:text-right', SEVERITY_TONE[r.severity.toLowerCase()] ?? 'text-muted-foreground')}>{r.severity || '—'}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
