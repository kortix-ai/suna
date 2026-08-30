'use client';

import { GithubLogoIcon, GlobeIcon, LockIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { infoToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/** Craft visibility. Mirrors the two states the real create flow will persist. */
type CraftVisibility = 'public' | 'private';

const VISIBILITY: Array<{
  id: CraftVisibility;
  label: string;
  icon: typeof GlobeIcon;
  hint: string;
}> = [
  {
    id: 'public',
    label: 'Public',
    icon: GlobeIcon,
    hint: 'Anyone in the crafts catalog can find and install it.',
  },
  {
    id: 'private',
    label: 'Private',
    icon: LockIcon,
    hint: 'Only this project can install it. It stays out of the catalog.',
  },
];

/**
 * Parses `owner/repo` out of whatever a person pastes — a browser URL, an
 * `.git` clone URL, an `ssh://` remote, or a bare `owner/repo`. Returns null
 * until the value identifies one repository, which is what gates Continue.
 */
export function parseRepoInput(value: string): { owner: string; repo: string } | null {
  const raw = value.trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/^git@github\.com:/i, '')
    .replace(/^(?:https?:\/\/|ssh:\/\/git@|git:\/\/)?(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
  // Reject anything still carrying a scheme or host — a non-GitHub URL must not
  // pass as `owner/repo`.
  if (/[:\s]/.test(cleaned)) return null;
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  const ok = /^[\w.-]+$/;
  if (!ok.test(owner) || !ok.test(repo)) return null;
  return { owner, repo };
}

/**
 * The add-a-craft modal — paste a GitHub repository, pick visibility, continue.
 *
 * UI PHASE: `Continue` performs no work. The real flow hands off to a chat
 * session that builds the craft from the repo; here it closes and toasts what
 * will happen, so the interaction reads complete without faking a session.
 */
export function AddCraftModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [url, setUrl] = useState('');
  const [visibility, setVisibility] = useState<CraftVisibility>('public');
  // Only complain once there is something to complain about — an empty field on
  // first open is not an error.
  const parsed = useMemo(() => parseRepoInput(url), [url]);
  const invalid = url.trim().length > 0 && !parsed;
  // Echo the parsed slug only when it tells the user something the field does
  // not already show — a pasted URL resolves to `owner/repo`, a typed
  // `owner/repo` would just repeat itself.
  const echo = parsed && url.trim() !== `${parsed.owner}/${parsed.repo}` ? parsed : null;

  const reset = () => {
    setUrl('');
    setVisibility('public');
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!parsed) return;
    onOpenChange(false);
    reset();
    infoToast(
      `Setting up ${parsed.owner}/${parsed.repo} (${visibility}) — this continues in a chat session.`,
    );
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <ModalContent className="lg:max-w-md" aria-label="Add a craft">
        <ModalHeader>
          <ModalTitle>Add a craft</ModalTitle>
          <ModalDescription>
            Point Kortix at a GitHub repository. It builds the craft from the source.
          </ModalDescription>
        </ModalHeader>
        <form onSubmit={submit}>
          <ModalBody className="space-y-5">
            <Field>
              <FieldLabel htmlFor="craft-repo-url">Repository</FieldLabel>
              <div className="relative">
                <GithubLogoIcon
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
                  aria-hidden
                />
                <Input
                  id="craft-repo-url"
                  variant="popover"
                  className="pl-9 font-mono"
                  placeholder="https://github.com/owner/repo"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  autoFocus
                  aria-invalid={invalid || undefined}
                />
              </div>
              {/* One line, three states: the parsed slug on success, the reason
                  on failure, the accepted forms before anything is typed. */}
              {echo ? (
                <FieldDescription className="text-foreground font-mono">
                  {echo.owner}/{echo.repo}
                </FieldDescription>
              ) : invalid ? (
                <FieldDescription className="text-kortix-red">
                  Paste a GitHub repository link, like github.com/owner/repo.
                </FieldDescription>
              ) : (
                <FieldDescription>
                  A URL, a clone link, or just <span className="font-mono">owner/repo</span>.
                </FieldDescription>
              )}
            </Field>

            <Field>
              <FieldLabel htmlFor="craft-visibility-public">Visibility</FieldLabel>
              <div
                id="craft-visibility"
                role="radiogroup"
                aria-label="Visibility"
                className="grid grid-cols-2 gap-2"
              >
                {VISIBILITY.map((option) => {
                  const OptionIcon = option.icon;
                  const active = visibility === option.id;
                  return (
                    <button
                      key={option.id}
                      id={`craft-visibility-${option.id}`}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setVisibility(option.id)}
                      className={cn(
                        'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-left text-sm font-medium',
                        'transition-colors duration-150 active:scale-[0.99]',
                        active
                          ? 'border-foreground/20 bg-primary/[0.06] text-foreground'
                          : 'bg-popover text-muted-foreground hover:border-foreground/20 hover:text-foreground',
                      )}
                    >
                      <OptionIcon className="size-4 shrink-0" aria-hidden />
                      {option.label}
                    </button>
                  );
                })}
              </div>
              <FieldDescription>
                {VISIBILITY.find((option) => option.id === visibility)?.hint}
              </FieldDescription>
            </Field>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!parsed}>
              Continue
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
