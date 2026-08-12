'use client';

/**
 * `CustomProviderPanel` — the Custom tab's whole body.
 *
 * ## Why this is a tab and not a section
 *
 * It used to be section 4 of the API-keys screen, behind an "Add a custom
 * provider" button. That put a job almost nobody does — pointing Kortix at a
 * self-hosted or unlisted OpenAI-compatible endpoint — at the bottom of the
 * screen EVERYBODY uses to paste an Anthropic key, where it was one more
 * heading to read past on the way to nothing.
 *
 * A tab costs the people who need it one click and costs everyone else
 * nothing, which is the trade a tab exists to make.
 *
 * ## Why the form is open, with no button in front of it
 *
 * Choosing the tab IS the disclosure. A tab whose entire content is a button
 * that reveals the content asks for the same decision twice.
 *
 * `CustomProviderForm` itself is mounted unchanged — same fields, same submit,
 * same mutation. `onBack`/`onDone` return the reader to the API keys tab,
 * because "done" here means the provider now has a key like any other and the
 * list is where it shows up.
 */

import { CustomProviderForm } from './custom-provider-form';

export function CustomProviderPanel({
  projectId,
  canWrite = false,
  onDone,
}: {
  projectId: string;
  canWrite?: boolean;
  /** Called on both Back and a successful save — hosts send the reader back to
   *  the API keys list, where the new provider now has a row. */
  onDone?: () => void;
}) {
  if (!canWrite) {
    return (
      <div className="flex min-h-[200px] flex-col items-center justify-center gap-1 px-6 text-center">
        <p className="text-foreground text-sm">Read-only access</p>
        <p className="text-muted-foreground max-w-xs text-xs text-pretty">
          Ask an owner of this project to connect a custom provider.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <CustomProviderForm
        projectId={projectId}
        onBack={() => onDone?.()}
        onDone={() => onDone?.()}
      />
    </div>
  );
}
