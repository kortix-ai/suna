'use client';

import {
  listConnectorAuthorizations,
  type AgentKnowledgeSource,
  type AgentProfile,
} from '@kortix/sdk';
import { type useAgentProfileMutations } from '@kortix/sdk/react';
import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  FileArrowUpIcon,
  FileTextIcon,
  GlobeSimpleIcon,
  LinkBreakIcon,
  LockKeyIcon,
  PlugsConnectedIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsListCompact, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';

type ProfileMutations = ReturnType<typeof useAgentProfileMutations>;

interface KnowledgeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: AgentProfile;
  mutations: ProfileMutations;
  onConflict: () => void;
}

const MAX_FILE_SIZE = 50 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function sourceIcon(source: AgentKnowledgeSource) {
  if (source.type === 'url') return GlobeSimpleIcon;
  if (source.type === 'connector') return PlugsConnectedIcon;
  return FileTextIcon;
}

function statusPresentation(source: AgentKnowledgeSource) {
  if (source.status === 'ready') {
    return { label: 'Ready', variant: 'success' as const, icon: CheckCircleIcon };
  }
  if (source.status === 'degraded') {
    return { label: 'Lexical search', variant: 'warning' as const, icon: WarningCircleIcon };
  }
  if (source.status === 'error') {
    return { label: 'Sync failed', variant: 'destructive' as const, icon: WarningCircleIcon };
  }
  if (source.status === 'syncing') {
    return { label: 'Syncing', variant: 'info' as const, icon: ArrowClockwiseIcon };
  }
  return { label: 'Pending', variant: 'muted' as const, icon: ArrowClockwiseIcon };
}

const SYNC_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

function formatSyncTime(value: string | null): string {
  if (!value) return 'Not synced yet';
  return `${SYNC_TIME_FORMATTER.format(new Date(value))} UTC`;
}

function titleFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const tail = url.pathname.split('/').filter(Boolean).at(-1);
    return tail ? decodeURIComponent(tail).replace(/[-_]+/g, ' ') : url.hostname;
  } catch {
    return 'Web page';
  }
}

export function AgentProfileKnowledgeDialog({
  open,
  onOpenChange,
  profile,
  mutations,
  onConflict,
}: KnowledgeDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState('upload');
  const [url, setUrl] = useState('');
  const [urlTitle, setUrlTitle] = useState('');
  const [connectorProfileId, setConnectorProfileId] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [resourceTitle, setResourceTitle] = useState('');
  const [automaticSync, setAutomaticSync] = useState(true);
  const [revokeTarget, setRevokeTarget] = useState<AgentKnowledgeSource | null>(null);
  const profiles = useQuery({
    queryKey: ['connector-profiles', profile.project_id],
    queryFn: () => listConnectorAuthorizations(profile.project_id),
    enabled: open,
    staleTime: 30_000,
  });
  const activeProfiles = useMemo(
    () => (profiles.data?.profiles ?? []).filter((item) => item.status === 'active'),
    [profiles.data?.profiles],
  );
  const isAdding = mutations.uploadKnowledge.isPending || mutations.createKnowledgeSource.isPending;

  const handleError = (error: unknown, fallback: string) => {
    onConflict();
    errorToast(errorMessage(error, fallback));
  };

  const uploadFile = async (file: File | undefined) => {
    if (!file) return;
    const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
    const contentType = MIME_BY_EXTENSION[extension] ?? file.type;
    if (!contentType || !Object.values(MIME_BY_EXTENSION).includes(contentType)) {
      errorToast('Choose a PDF, DOCX, TXT, Markdown, CSV, or HTML file.');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      errorToast('Knowledge files must be 50 MB or smaller.');
      return;
    }
    try {
      await mutations.uploadKnowledge.mutateAsync({
        fileName: file.name,
        contentType,
        data: file,
      });
      successToast(`${file.name} added to the draft`);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (error) {
      handleError(error, 'Knowledge file could not be uploaded');
    }
  };

  const addUrl = async () => {
    try {
      await mutations.createKnowledgeSource.mutateAsync({
        type: 'url',
        title: urlTitle.trim() || titleFromUrl(url),
        url: url.trim(),
        automaticSync,
      });
      setUrl('');
      setUrlTitle('');
      successToast('Web page added to the draft');
    } catch (error) {
      handleError(error, 'Web page could not be added');
    }
  };

  const addConnectedResource = async () => {
    const selected = activeProfiles.find((item) => item.profile_id === connectorProfileId);
    if (!selected) return;
    try {
      await mutations.createKnowledgeSource.mutateAsync({
        type: 'connector',
        title: resourceTitle.trim() || `${selected.label} resource`,
        connectorProfileId,
        resourceId: resourceId.trim(),
        automaticSync,
      });
      setResourceId('');
      setResourceTitle('');
      successToast('Connected resource added to the draft');
    } catch (error) {
      handleError(error, 'Connected resource could not be added');
    }
  };

  const sync = async (source: AgentKnowledgeSource) => {
    try {
      await mutations.syncKnowledge.mutateAsync(source.source_id);
      successToast(`Sync started for ${source.title}`);
    } catch (error) {
      handleError(error, 'Knowledge sync could not start');
    }
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    try {
      await mutations.revokeKnowledge.mutateAsync(revokeTarget.source_id);
      successToast(`${revokeTarget.title} revoked`);
      setRevokeTarget(null);
    } catch (error) {
      handleError(error, 'Knowledge source could not be revoked');
    }
  };

  return (
    <>
      <Modal open={open} onOpenChange={onOpenChange}>
        <ModalContent variant="base" className="lg:max-w-3xl">
          <ModalHeader>
            <ModalTitle>Knowledge</ModalTitle>
            <ModalDescription>Add private sources used in cited answers.</ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[72vh] space-y-6 overflow-y-auto pt-5">
            <Tabs value={mode} onValueChange={setMode}>
              <TabsListCompact className="w-full" aria-label="Knowledge source type">
                <TabsTrigger value="upload" className="flex-1">
                  Upload
                </TabsTrigger>
                <TabsTrigger value="url" className="flex-1">
                  Web page
                </TabsTrigger>
                <TabsTrigger value="connector" className="flex-1">
                  Connected app
                </TabsTrigger>
              </TabsListCompact>

              <TabsContent value="upload" className="pt-5">
                <button
                  type="button"
                  className="border-border hover:bg-muted/40 focus-visible:ring-ring flex min-h-32 w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed px-5 text-center transition-[color,background-color] outline-none focus-visible:ring-2"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isAdding}
                >
                  {mutations.uploadKnowledge.isPending ? (
                    <Loading className="size-5" />
                  ) : (
                    <FileArrowUpIcon className="text-muted-foreground size-5" />
                  )}
                  <span className="text-sm font-medium">Choose a file</span>
                  <span className="text-muted-foreground text-xs">
                    PDF, DOCX, TXT, Markdown, CSV, or HTML up to 50 MB
                  </span>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="sr-only"
                  aria-label="Knowledge file"
                  accept=".pdf,.docx,.txt,.md,.markdown,.csv,.html,.htm"
                  onChange={(event) => void uploadFile(event.target.files?.[0])}
                />
              </TabsContent>

              <TabsContent value="url" className="pt-5">
                <FieldGroup className="gap-4">
                  <Field>
                    <FieldLabel htmlFor="knowledge-url">Page URL</FieldLabel>
                    <Input
                      id="knowledge-url"
                      type="url"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder="https://docs.example.com/handbook"
                    />
                    <FieldDescription>Only this page is synchronized.</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="knowledge-url-title">Name</FieldLabel>
                    <Input
                      id="knowledge-url-title"
                      value={urlTitle}
                      onChange={(event) => setUrlTitle(event.target.value)}
                      placeholder="Derived from the page URL"
                      maxLength={500}
                    />
                  </Field>
                  <label className="flex min-h-10 items-center justify-between gap-3 text-sm">
                    Synchronize every 24 hours
                    <Switch checked={automaticSync} onCheckedChange={setAutomaticSync} />
                  </label>
                  <Button
                    className="self-end"
                    size="sm"
                    disabled={!url.trim() || isAdding}
                    onClick={addUrl}
                  >
                    {mutations.createKnowledgeSource.isPending ? (
                      <Loading className="size-3" />
                    ) : null}
                    Add page
                  </Button>
                </FieldGroup>
              </TabsContent>

              <TabsContent value="connector" className="pt-5">
                <FieldGroup className="gap-4">
                  <Field>
                    <FieldLabel htmlFor="knowledge-connection">Connected account</FieldLabel>
                    <Select value={connectorProfileId} onValueChange={setConnectorProfileId}>
                      <SelectTrigger id="knowledge-connection">
                        <SelectValue placeholder="Select an account" />
                      </SelectTrigger>
                      <SelectContent>
                        {activeProfiles.map((authorization) => (
                          <SelectItem
                            key={authorization.profile_id}
                            value={authorization.profile_id}
                          >
                            {authorization.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {activeProfiles.length === 0 && !profiles.isLoading ? (
                      <FieldDescription>No connected accounts are available.</FieldDescription>
                    ) : null}
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="knowledge-resource">Resource link or ID</FieldLabel>
                    <Input
                      id="knowledge-resource"
                      value={resourceId}
                      onChange={(event) => setResourceId(event.target.value)}
                      placeholder="Paste the selected document, page, or file"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="knowledge-resource-title">Name</FieldLabel>
                    <Input
                      id="knowledge-resource-title"
                      value={resourceTitle}
                      onChange={(event) => setResourceTitle(event.target.value)}
                      placeholder="Team handbook"
                      maxLength={500}
                    />
                  </Field>
                  <label className="flex min-h-10 items-center justify-between gap-3 text-sm">
                    Synchronize every 24 hours
                    <Switch checked={automaticSync} onCheckedChange={setAutomaticSync} />
                  </label>
                  <Button
                    className="self-end"
                    size="sm"
                    disabled={!connectorProfileId || !resourceId.trim() || isAdding}
                    onClick={addConnectedResource}
                  >
                    {mutations.createKnowledgeSource.isPending ? (
                      <Loading className="size-3" />
                    ) : null}
                    Add resource
                  </Button>
                </FieldGroup>
              </TabsContent>
            </Tabs>

            <section className="space-y-2" aria-labelledby="knowledge-sources-heading">
              <div className="flex items-center justify-between gap-3">
                <h3 id="knowledge-sources-heading" className="text-sm font-medium">
                  Sources
                </h3>
                <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                  <LockKeyIcon className="size-3" /> Private
                </span>
              </div>
              {profile.knowledge_sources.length === 0 ? (
                <div className="border-border flex min-h-24 items-center gap-3 border-y py-4">
                  <FileTextIcon className="text-muted-foreground size-5" />
                  <p className="text-muted-foreground text-sm">No knowledge sources.</p>
                </div>
              ) : (
                <div className="divide-border divide-y">
                  {profile.knowledge_sources.map((source) => {
                    const SourceIcon = sourceIcon(source);
                    const status = statusPresentation(source);
                    const StatusIcon = status.icon;
                    const syncing =
                      mutations.syncKnowledge.isPending &&
                      mutations.syncKnowledge.variables === source.source_id;
                    return (
                      <article key={source.source_id} className="flex gap-3 py-3">
                        <span className="bg-muted inline-flex size-9 shrink-0 items-center justify-center rounded-sm">
                          <SourceIcon className="size-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="min-w-0 truncate text-sm font-medium">{source.title}</h4>
                            <Badge size="xs" variant={status.variant}>
                              <StatusIcon className="size-2.5" />
                              {status.label}
                            </Badge>
                          </div>
                          <p className="text-muted-foreground mt-1 text-xs">
                            Last successful sync: {formatSyncTime(source.last_successful_sync_at)}
                          </p>
                          <p className="text-muted-foreground mt-0.5 text-xs tabular-nums">
                            {source.active_version
                              ? `${source.active_version.chunk_count} cited passages indexed`
                              : 'Citations available after indexing'}
                          </p>
                          {source.error ? (
                            <p className="text-destructive mt-1 text-xs" role="alert">
                              {source.error}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-start gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Sync ${source.title} now`}
                            disabled={syncing}
                            onClick={() => void sync(source)}
                          >
                            {syncing ? (
                              <Loading className="size-3.5" />
                            ) : (
                              <ArrowClockwiseIcon className="size-3.5" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Revoke ${source.title}`}
                            onClick={() => setRevokeTarget(source)}
                          >
                            <LinkBreakIcon className="size-3.5" />
                          </Button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </ModalBody>
          <ModalFooter className="border-border border-t py-3">
            <Button size="sm" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(next) => !next && setRevokeTarget(null)}
        title="Revoke knowledge source"
        description={
          revokeTarget
            ? `${revokeTarget.title} becomes unavailable to the agent immediately. Its repository assignment is removed when this draft is published.`
            : ''
        }
        confirmLabel="Revoke"
        confirmVariant="destructive"
        confirmIcon={<LinkBreakIcon className="size-3.5" />}
        isPending={mutations.revokeKnowledge.isPending}
        onConfirm={() => void revoke()}
      />
    </>
  );
}
