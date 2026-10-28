'use client';

import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { RadioGroup, RadioGroupItem } from '@kortix/ui/radio-group';
import { CheckCircleIcon, MagnifyingGlassIcon, UsersIcon } from '@phosphor-icons/react';

import { AppBoard, FINAL, Session } from './session-window';
import { useBeats } from './use-beats';

/**
 * Workspace step 4, "Share with your team": the finished dashboard session
 * with its Share dialog open, drawn like ShareSessionModal
 * (packages/ui/src/workspace/sidebar/modal/share-session-modal.tsx) with its
 * SharingPicker and PrincipalPicker, and their real labels. The scene picks
 * "Specific people", then adds the Finance group and one member.
 * Synthetic Arcadia fixture: people are numbered, never named.
 */

/** Share beats: the dialog opens, "Specific people" is picked, a group is added, a person is added. */
const SHARE_BEATS = [400, 1500, 2700, 3800] as const;

const GROUPS = ['Finance', 'Sales'];
const MEMBERS = ['Member 2', 'Member 3'];
const PICKED = new Map([
  ['Finance', 3],
  ['Member 2', 4],
]);

function PickerLabel({ children }: { children: string }) {
  return (
    <p className="text-muted-foreground px-2 pt-2 pb-1 text-xs font-medium first:pt-1.5">
      {children}
    </p>
  );
}

function PickerRow({
  label,
  group,
  selected,
}: {
  label: string;
  group?: boolean;
  selected: boolean;
}) {
  return (
    <div
      className={cn(
        'duration-slower flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors ease-out',
        selected && 'bg-muted',
      )}
    >
      {group ? (
        <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-md">
          <UsersIcon className="size-3.5" />
        </span>
      ) : (
        <span className="bg-foreground text-background flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium">
          M
        </span>
      )}
      <span className="text-foreground min-w-0 flex-1 truncate text-sm">
        {label}
        {group ? <span className="text-muted-foreground ml-1 text-xs">· group</span> : null}
      </span>
      <CheckCircleIcon
        weight="fill"
        aria-hidden
        className={cn(
          'duration-slower size-4.5 shrink-0 transition-opacity ease-out',
          selected ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  );
}

function ShareDialog({ beat }: { beat: number }) {
  const mode = beat >= 2 ? 'members' : 'project';
  const isPicked = (name: string) => beat >= (PICKED.get(name) ?? Infinity);
  const count = [...PICKED.values()].filter((at) => beat >= at).length;
  return (
    <div
      role="dialog"
      aria-label="Session access"
      className="bg-sidebar border-muted flex w-112 flex-col gap-4 rounded-xl border shadow-lg"
    >
      <header className="flex flex-col px-5 pt-5">
        <h4 className="text-foreground text-base font-semibold">Session access</h4>
        <p className="text-muted-foreground text-sm">
          Choose who can open this session. Anyone with access can read the conversation and
          continue it.
        </p>
      </header>
      <div className="flex flex-col gap-3 px-5">
        <p className="text-sm font-medium">Who can open this session</p>
        <RadioGroup value={mode} className="gap-2" tabIndex={-1}>
          <RadioGroupItem
            value="project"
            label="Whole project"
            description="Every member of this project."
            size="lg"
            variant="outline"
          />
          <RadioGroupItem
            value="private"
            label="Only you"
            description="Nobody else can open this session."
            size="lg"
            variant="outline"
          />
          <RadioGroupItem
            value="members"
            label="Specific people"
            description="Only the members and groups you choose."
            size="lg"
            variant="outline"
          />
        </RadioGroup>
        {/* Opens under "Specific people": a grid-rows fold (motion.md, no
            height transition), then the list fades in. */}
        <div
          className={cn(
            'duration-slow grid transition-[grid-template-rows,opacity] ease-out motion-reduce:transition-opacity',
            mode === 'members' ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="overflow-hidden rounded-md border">
              <div className="text-muted-foreground flex h-9 items-center gap-2 border-b px-3 text-sm">
                <MagnifyingGlassIcon className="size-4" aria-hidden />
                Search members, groups, or agents
              </div>
              <div className="flex h-8 items-center justify-between border-b px-3">
                <span className="text-muted-foreground text-xs tabular-nums">{count} selected</span>
                <span className="text-muted-foreground text-xs">Clear</span>
              </div>
              <div className="p-1">
                <PickerLabel>Groups</PickerLabel>
                {GROUPS.map((g) => (
                  <PickerRow key={g} label={g} group selected={isPicked(g)} />
                ))}
                <PickerLabel>Members</PickerLabel>
                {MEMBERS.map((m) => (
                  <PickerRow key={m} label={m} selected={isPicked(m)} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <footer className="flex items-center justify-between px-5 pb-5">
        <Button variant="outline-ghost" size="sm" tabIndex={-1}>
          Cancel
        </Button>
        <Button size="sm" tabIndex={-1} disabled={count === 0}>
          Save
        </Button>
      </footer>
    </div>
  );
}

export function ShareScene({ play }: { play: boolean }) {
  const beat = useBeats(play, SHARE_BEATS);
  const open = beat >= 1;
  return (
    <AppBoard
      framed={false}
      overlay={
        <div
          aria-hidden={!open}
          className={cn(
            'bg-background/60 duration-slow absolute inset-0 flex items-center justify-center transition-opacity ease-out',
            open ? 'opacity-100' : 'opacity-0',
          )}
        >
          <div
            className={cn(
              'duration-slow transition-[opacity,scale] ease-out motion-reduce:transition-opacity',
              open ? 'scale-100 opacity-100' : 'scale-95 opacity-0',
            )}
          >
            <ShareDialog beat={beat} />
          </div>
        </div>
      }
    >
      <Session stage={FINAL} sharing={open} />
    </AppBoard>
  );
}
