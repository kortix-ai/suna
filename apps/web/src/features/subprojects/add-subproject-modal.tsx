'use client';

import {
  ArrowClockwiseIcon,
  FileZipIcon,
  GithubLogoIcon,
  UploadSimpleIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useMemo, useRef, useState } from 'react';

import { parseSubprojectRepo } from '@kortix/manifest-schema';
import type { SubmittableSubprojectVisibility, SubprojectSubmitResult } from '@kortix/sdk';
import { useSubprojects } from '@kortix/sdk/react';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Tabs, TabsContent, TabsListCompact, TabsTrigger } from '@/components/ui/tabs';
import { successToast, warningToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { countLabel } from './subprojects-catalog';

/*
 * `parseSubprojectRepo` comes from `@kortix/manifest-schema`, not from a copy in
 * this file. It is the SAME function the API's submit route runs, so the modal
 * cannot accept an address the server would reject, or vice versa. It has its
 * own test corpus there (`__tests__/subproject-repo.test.ts`); the local
 * `parseRepoInput` this file used to export is gone.
 */

/**
 * The two scopes a person can choose, in widest-first order — the same order
 * and the same label/description radio shape the session-access dialog uses
 * (`SharingPicker`), because this is the same question about a different noun.
 *
 * `public` — every Kortix user, in every account — is deliberately ABSENT. It
 * is a real value of the `subproject_visibility` enum, and the globally listed
 * subprojects hold it, but they are seeded by migration or inserted directly.
 * Four separate things keep a submission out of it, and this list is only the
 * first. The `id` type is `SubmittableSubprojectVisibility`
 * (`Exclude<SubprojectVisibility, 'public'>`), so an added `public` entry fails
 * to compile. `POST /v1/subprojects` validates `z.enum(['account','private'])`
 * on BOTH body shapes — JSON and multipart — so a hand-built request answers
 * `400 invalid_enum_value`. And behind that validator the handler still coerces
 * any present non-`account` value to `private`, so a body shape added later
 * cannot widen a subproject by skipping a validator.
 *
 * `account` is the default. It matches "Whole project" leading the session
 * dialog, and it is what the account-scoped catalog already did before
 * `private` meant anything narrower than the account.
 */
const VISIBILITY: Array<{
  id: SubmittableSubprojectVisibility;
  label: string;
  desc: string;
}> = [
  {
    id: 'account',
    label: 'Everyone in your account',
    desc: 'Anyone in this account can find it in the marketplace and install it.',
  },
  {
    id: 'private',
    label: 'Only you',
    desc: 'Nobody else in this account sees it.',
  },
];

/**
 * The server enforces TWO different bounds, and this field can only check one.
 *
 * `MAX_ARCHIVE_BYTES` is the ENVELOPE — `MAX_UPLOAD_BYTES` in the submit route,
 * checked on the declared size before anything is read. That is what
 * `File.size` actually is, so it is the only one checkable here.
 *
 * The other is the extracted TEXT total (`SUBPROJECT_ZIP_LIMITS.maxTotalBytes`, 5 MB),
 * which cannot be known without unzipping. A compressed archive under the
 * envelope can still exceed it, and the server answers `archive_refused` with
 * the reason — which is why the field describes both and the error path renders
 * the server's own message.
 *
 * This used to be 1_000_000 — the TEXT cap — compared against the archive size.
 * It rejected a 2 MB zip that would have extracted to 300 KB of text and
 * indexed fine.
 */
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
/** The extracted-text cap, for the field's description only. Not checkable here. */
const MAX_TEXT_BYTES = 5_000_000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Turn whatever the API returned into one sentence a person can act on.
 *
 * The submit route answers `400` with a machine `code` for every rejection it
 * can name — no manifest, invalid manifest, unreachable repo, bad ref, refused
 * archive. Rendering the raw code would be honest but useless; rendering a
 * generic "something went wrong" would be useless AND vague. So each code gets
 * the sentence that says what to do next.
 *
 * `mode` is passed because one code — `manifest_not_found`, the most common
 * rejection — has two different next steps. `kortix init` is the answer for a
 * repo and nonsense for a `.zip`, which the user has to rebuild instead.
 */
function submitErrorMessage(error: unknown, mode: 'repo' | 'upload'): string {
  const detail = error as { code?: string; message?: string } | null;
  switch (detail?.code) {
    case 'manifest_not_found':
      return mode === 'upload'
        ? 'No kortix.yaml at the root of that archive. A subproject is a Kortix project — zip it from the project directory so kortix.yaml sits at the top level.'
        : 'No kortix.yaml in that repository. A subproject is a Kortix project — run `kortix init` in it first.';
    case 'manifest_invalid':
      return (
        detail.message ?? 'That kortix.yaml did not validate. Run `kortix validate` against it.'
      );
    case 'ref_not_found':
      return 'That branch or tag does not exist in the repository.';
    case 'repo_not_found':
      return 'Repository not found. A private repo has to be reachable by this account.';
    case 'upstream_unavailable':
      return 'GitHub did not answer. Try again in a moment.';
    case 'invalid_archive':
      return 'That file is not a readable .zip archive.';
    case 'archive_refused':
      // Prefer the server's own message: it knows WHICH bound was hit (total
      // text, one oversized file, or the file count) and this UI does not.
      return (
        detail.message ??
        `The archive is over the limits — ${formatBytes(MAX_TEXT_BYTES)} of text, 256 KB per file, 200 files.`
      );
    default:
      return detail?.message ?? 'Could not add that subproject.';
  }
}

/** Report the crawl's advisory findings. The subproject IS indexed — never block. */
function reportWarnings(result: SubprojectSubmitResult): void {
  if (result.warnings.length === 0) {
    successToast(`${result.subproject.title} added to your subprojects`);
    return;
  }
  // One toast, not one per finding: three warnings would otherwise stack three
  // toasts over the grid the user is trying to look at.
  warningToast(
    `${result.subproject.title} added with ${countLabel(result.warnings.length, 'warning')}: ${result.warnings[0]}`,
  );
}

/**
 * The add-a-subproject modal — two ways in, one result.
 *
 * **Repository** points the index at a public or reachable GitHub repo. The
 * server crawls it at a resolved commit, so the subproject tracks that repo.
 *
 * **Upload** takes a `.zip` of the same thing. This exists because the common
 * case for a first subproject is a folder on someone's laptop that is not a repo
 * yet, and "go create a GitHub repo first" is a wall in front of the one action
 * this modal is for. An uploaded subproject is a SNAPSHOT — its files are stored as
 * submitted, and re-uploading replaces it. The tab says so rather than letting
 * someone discover it later.
 *
 * `Add` performs the real submission. It does not close on failure: the error
 * belongs beside the field that caused it, and a modal that vanished would take
 * the pasted URL with it.
 */
export function AddSubprojectModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { submit, submitArchive } = useSubprojects();
  const [mode, setMode] = useState<'repo' | 'upload'>('repo');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [visibility, setVisibility] = useState<SubmittableSubprojectVisibility>('account');
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Only complain once there is something to complain about — an empty field on
  // first open is not an error.
  const parsed = useMemo(() => parseSubprojectRepo(url), [url]);
  const invalid = url.trim().length > 0 && !parsed;
  // Echo the parsed address only when it tells the user something the field
  // does not already show — a pasted URL resolves to `owner/repo`, a typed
  // `owner/repo` would just repeat itself.
  const normalized = parsed
    ? `${parsed.owner}/${parsed.repo}${parsed.ref ? `@${parsed.ref}` : ''}`
    : null;
  const echo = normalized && url.trim() !== normalized ? normalized : null;

  const oversize = !!file && file.size > MAX_ARCHIVE_BYTES;
  const pending = submit.isPending || submitArchive.isPending;
  const ready = mode === 'repo' ? !!parsed : !!file && !oversize;

  const reset = () => {
    setUrl('');
    setFile(null);
    setVisibility('account');
    setError(null);
    setMode('repo');
  };

  const chooseFile = (next: File | null) => {
    setFile(next);
    setError(null);
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || pending) return;
    setError(null);
    try {
      const result =
        mode === 'repo'
          ? await submit.mutateAsync({ repo: normalized as string, visibility })
          : await submitArchive.mutateAsync({ file: file as File, visibility });
      reportWarnings(result);
      onOpenChange(false);
      reset();
    } catch (caught) {
      // Stay open. The message belongs beside the input that caused it, and
      // closing would discard what the user pasted.
      setError(submitErrorMessage(caught, mode));
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <ModalContent className="lg:max-w-md" aria-label="Add a subproject">
        <ModalHeader>
          <ModalTitle>Add a subproject</ModalTitle>
          <ModalDescription>
            A subproject is a Kortix project — a <span className="font-mono">kortix.yaml</span> with
            its agents, skills, connectors and triggers.
          </ModalDescription>
        </ModalHeader>
        <form onSubmit={onSubmit}>
          <ModalBody className="space-y-5">
            <Tabs
              value={mode}
              onValueChange={(next) => {
                setMode(next as 'repo' | 'upload');
                setError(null);
              }}
            >
              <TabsListCompact>
                <TabsTrigger value="repo" className="gap-1.5">
                  <GithubLogoIcon className="size-3.5 shrink-0" aria-hidden />
                  Repository
                </TabsTrigger>
                <TabsTrigger value="upload" className="gap-1.5">
                  <FileZipIcon className="size-3.5 shrink-0" aria-hidden />
                  Upload .zip
                </TabsTrigger>
              </TabsListCompact>

              <TabsContent value="repo" className="mt-4">
                <Field>
                  <FieldLabel htmlFor="subproject-repo-url">Repository</FieldLabel>
                  <div className="relative">
                    <GithubLogoIcon
                      className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
                      aria-hidden
                    />
                    <Input
                      id="subproject-repo-url"
                      variant="popover"
                      className="pl-9 font-mono"
                      placeholder="https://github.com/owner/repo"
                      value={url}
                      onChange={(event) => {
                        setUrl(event.target.value);
                        setError(null);
                      }}
                      autoFocus
                      aria-invalid={invalid || undefined}
                    />
                  </div>
                  {/* One line, three states: the normalized address on success,
                      the reason on failure, the accepted forms before anything
                      is typed. */}
                  {echo ? (
                    <FieldDescription className="text-foreground font-mono">
                      {echo}
                    </FieldDescription>
                  ) : invalid ? (
                    <FieldDescription className="text-kortix-red">
                      Paste a GitHub repository link, like github.com/owner/repo.
                    </FieldDescription>
                  ) : (
                    <FieldDescription>
                      A URL, a clone link, or <span className="font-mono">owner/repo</span> — add{' '}
                      <span className="font-mono">@branch</span> to pin one.
                    </FieldDescription>
                  )}
                </Field>
              </TabsContent>

              <TabsContent value="upload" className="mt-4">
                <Field>
                  <FieldLabel htmlFor="subproject-archive">Archive</FieldLabel>
                  {/* A hidden input behind a real button, not a bare file input:
                      the native control cannot be styled and reads nothing like
                      the rest of this modal. */}
                  <input
                    ref={fileInput}
                    id="subproject-archive"
                    type="file"
                    accept=".zip,application/zip"
                    className="hidden"
                    onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
                  />
                  {file ? (
                    <div
                      className={cn(
                        'bg-popover flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-xs',
                        oversize && 'border-kortix-red/40',
                      )}
                    >
                      <FileZipIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
                      <span className="text-foreground min-w-0 flex-1 truncate font-mono">
                        {file.name}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 tabular-nums',
                          oversize ? 'text-kortix-red' : 'text-muted-foreground',
                        )}
                      >
                        {formatBytes(file.size)}
                      </span>
                      <button
                        type="button"
                        aria-label="Remove file"
                        onClick={() => {
                          chooseFile(null);
                          if (fileInput.current) fileInput.current.value = '';
                        }}
                        className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer transition-colors duration-150"
                      >
                        <XIcon className="size-3.5" aria-hidden />
                      </button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full gap-1.5"
                      onClick={() => fileInput.current?.click()}
                    >
                      <UploadSimpleIcon className="size-3.5 shrink-0" aria-hidden />
                      Choose a .zip
                    </Button>
                  )}
                  {oversize ? (
                    <FieldDescription className="text-kortix-red">
                      Over the {formatBytes(MAX_ARCHIVE_BYTES)} archive limit. Drop build output and
                      node_modules — only text files are kept anyway.
                    </FieldDescription>
                  ) : (
                    <FieldDescription>
                      Zip the folder holding <span className="font-mono">kortix.yaml</span> — the
                      whole project is fine. Only the subproject is kept: the manifest and{' '}
                      <span className="font-mono">.kortix/</span> (agents and skills).
                    </FieldDescription>
                  )}
                  {/* Said here, at the moment of choosing, not discovered later:
                      an upload has no repo to re-crawl, so it never updates on
                      its own. */}
                  <InfoBanner
                    tone="neutral"
                    icon={<ArrowClockwiseIcon className="size-3.5" aria-hidden />}
                    title="An uploaded subproject is a snapshot"
                  >
                    It does not track a repository. Upload again to replace it.
                  </InfoBanner>
                </Field>
              </TabsContent>
            </Tabs>

            {/* The same control as session access, down to the primitives:
                a heading, then one bordered card per scope carrying its own
                description. The two-icon-buttons grid this replaces put the
                consequence in a single line UNDER the group, so whichever
                option you were not on never stated what it would do. */}
            <div className="space-y-3">
              <Label id="subproject-visibility-heading">Who can find and install it</Label>
              <RadioGroup
                value={visibility}
                onValueChange={(next) => setVisibility(next as SubmittableSubprojectVisibility)}
                aria-labelledby="subproject-visibility-heading"
                className="space-y-2"
              >
                {VISIBILITY.map((option) => (
                  <RadioGroupItem
                    key={option.id}
                    value={option.id}
                    id={`subproject-visibility-${option.id}`}
                    label={option.label}
                    description={option.desc}
                    size="lg"
                    variant="outline"
                  />
                ))}
              </RadioGroup>
            </div>

            {error ? (
              <InfoBanner
                tone="destructive"
                icon={<WarningIcon className="size-3.5" aria-hidden />}
                title="Could not add this subproject"
              >
                {error}
              </InfoBanner>
            ) : null}
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || pending}>
              {pending ? <Loading className="size-4 shrink-0" /> : null}
              {pending ? 'Adding' : 'Add subproject'}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
