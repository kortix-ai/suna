'use client';

/**
 * `ProjectProviderModal` — the QUICK version of the Models page, and nothing
 * else.
 *
 * ## It is the same screen, or it is wrong
 *
 * This dialog used to be a second implementation of model management: its own
 * `Tabs` root, its own underline tab row at `text-xs`, its own labels ("API
 * keys" where the page says "Providers"), no project-default control, and — the
 * visible bug — a scroll body with NO horizontal padding, so the search field
 * and every model row ran edge to edge under a heading indented 20px, and the
 * row card's rounded border was clipped away by the modal's `overflow-hidden`.
 * Beside the page it read as a different, older product.
 *
 * There is one implementation now. Every part below is imported from
 * `gateway-view.tsx`, the Customize page's own module:
 *
 *   - `MODELS_PAGE_TITLE` / `MODELS_PAGE_DESCRIPTION` — the same two lines.
 *   - `ProjectDefaultPicker` — the same one page-level control, in the same
 *     place relative to the heading.
 *   - `QUICK_LLM_TABS` + `LlmTabStrip` — the same pill strip, the same labels,
 *     the same order. A slice of `LLM_TABS`, never a second list.
 *   - `LlmSections` — the same section bodies, chosen the same way.
 *
 * This file contributes the dialog chrome and the padded column, full stop. It
 * declares no `TabsTrigger`, no section, and no label of its own; a change to
 * any of those has exactly one place to be made.
 *
 * ## Why three tabs and not seven
 *
 * The page carries Providers / Models / Custom / Gateway / Routing / Costs /
 * Logs. This dialog opens from the session model picker's connect gate
 * (`use-model-connection-gate.tsx`) and the Secrets tab's "Manage providers"
 * (`secrets-view.tsx`) — both are "let me use a model right now" moments. It
 * carries the three tabs that answer that and drops the four that are project
 * administration; a log table wants the page's width and height, not 680px of
 * dialog. `QUICK_LLM_TABS` is that decision, expressed once.
 *
 * The Models settings tab mounts `LlmManagementView` DIRECTLY — connecting a
 * provider there opens no dialog at all, which is JAY-510's first acceptance
 * criterion.
 */

import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import {
  isQuickLlmTab,
  LlmSections,
  LlmTabStrip,
  MODELS_PAGE_DESCRIPTION,
  MODELS_PAGE_TITLE,
  ProjectDefaultPicker,
  QUICK_LLM_TABS,
} from '@/features/workspace/customize/sections/gateway-view';
import { useState } from 'react';
import type { ActiveTab, ProjectProviderModalProps } from './types';
import { pickInitialTab } from './utils';

export type { ProjectProviderModalProps } from './types';

export function ProjectProviderModal({
  projectId,
  open,
  onOpenChange,
  defaultTab,
  canWrite = false,
}: ProjectProviderModalProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      {/* ONE height, declared once as a var and pinned from both sides.
          `h-` alone is not enough on desktop: ModalVariants' bottom side
          carries `lg:h-auto` (modal.tsx), which twMerge does NOT collapse
          into the unprefixed `h-[…]` (different modifier group) — so the
          modal silently became content-sized at `lg:` and its height jumped
          with every tab switch (3 key rows vs 34 model rows vs the Custom
          form). `lg:min-h` + `lg:max-h` clamp that `h-auto` to a constant.
          The unprefixed mobile sheet keeps its own `max-h-[90%]` cap. */}
      <ModalContent className="flex h-(--provider-modal-h) w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 [--provider-modal-h:min(680px,calc(100dvh-2rem))] lg:max-h-(--provider-modal-h) lg:min-h-(--provider-modal-h) lg:max-w-4xl">
        <ProviderModalBody
          key={`${open}-${defaultTab ?? ''}`}
          projectId={projectId}
          open={open}
          canWrite={canWrite}
          defaultTab={defaultTab}
        />
      </ModalContent>
    </Modal>
  );
}

/**
 * The body, below the `key` boundary the shell owns.
 *
 * CONTROLLED, but with no effect and no re-seeding: `useState`'s initializer
 * runs once per mount, and the parent's `key={`${open}-${defaultTab}`}`
 * remounts this on every open — so reopening still lands on the requested tab,
 * exactly as the uncontrolled version did, with no `setState` in an effect
 * body (`react-hooks/set-state-in-effect`).
 *
 * Controlled at all because `LlmSections` hands the reader on: saving a custom
 * provider gives it a key like any other and a row on the provider list, so a
 * "Done" that leaves you on the form you just submitted is not done.
 */
function ProviderModalBody({
  projectId,
  open,
  canWrite,
  defaultTab,
}: {
  projectId: string;
  open: boolean;
  canWrite: boolean;
  defaultTab?: ActiveTab;
}) {
  const [tab, setTab] = useState<ActiveTab>(() => pickInitialTab(defaultTab));

  return (
    <>
      {/* The page's header, in a dialog: heading and description on the left,
          the one page-level control on the right. `pr-11` is the modal's close
          button — `absolute top-3 right-3` at `size-8`, so 44px of the right
          edge is spoken for and the picker has to stop short of it. */}
      <ModalHeader className="shrink-0 gap-3 sm:flex-row sm:items-start sm:justify-between sm:pr-11">
        <div className="space-y-1">
          <ModalTitle className="text-base font-medium">{MODELS_PAGE_TITLE}</ModalTitle>
          <ModalDescription>{MODELS_PAGE_DESCRIPTION}</ModalDescription>
        </div>
        {canWrite ? <ProjectDefaultPicker projectId={projectId} /> : null}
      </ModalHeader>

      <div className="shrink-0 px-5 pt-5 pb-4">
        <LlmTabStrip
          value={tab}
          tabs={QUICK_LLM_TABS}
          onValueChange={(next) => {
            if (isQuickLlmTab(next)) setTab(next);
          }}
        />
      </div>

      {/* The column. `px-5` is the whole reason the model rows now line up
          under the heading instead of running into the modal's clipped edge —
          `LlmSections` carries no horizontal padding of its own, because on
          the page `CapabilityPageShell` supplies it. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        <LlmSections
          projectId={projectId}
          tab={tab}
          onTabChange={(next) => {
            if (isQuickLlmTab(next)) setTab(next);
          }}
          canWrite={canWrite}
          enabled={open}
        />
      </div>
    </>
  );
}
