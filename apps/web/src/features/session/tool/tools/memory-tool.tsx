'use client';

import { CopyOverlay } from '@/components/markdown/code';
import { MarkdownFrontmatterCard, parseFrontmatter } from '@/components/markdown/markdown-frontmatter';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import {
  BasicTool,
  InlineDiffView,
  isErrorOutput,
  MD_FLUSH_CLASSES,
  partInput,
  partOutput,
  partStatus,
  partStreamingInput,
  ToolCode,
  ToolCodeCard,
  ToolEmptyState,
  ToolOutputFallback,
  ToolRunningContext,
  useToolIndent,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { ToolError } from '@/features/session/tool/tool-error';
import { cn } from '@/lib/utils';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import {
  BrainIcon as Brain,
  CaretRightIcon as ChevronRight,
  TrashIcon as Trash2,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { type ReactNode, useContext, useMemo } from 'react';

import { memoryRelPath, parseMemoryView } from '@/features/session/tool/shared/memory-helpers';

/** The commands that CHANGE what the agent will remember. `view` is the only read. */
const MEMORY_UPDATE_COMMANDS: ReadonlySet<string> = new Set([
  'create',
  'insert',
  'str_replace',
  'rename',
  'delete',
]);

/**
 * The row's title, from the command the call ran.
 *
 * The `memory` tool multiplexes six commands over one name, so the old fixed
 * "Memory" title said only that the tool ran — a write and a read were the same
 * row. Two outcomes are worth telling apart: the call changed what the agent
 * remembers, or it did not.
 *
 * An unrecognised command — or one that has not finished streaming — falls back
 * to the bare noun. A guessed verb is worse than no verb.
 *
 * This is the chat row's own title and lives here. The Easy panel's sentences
 * for the same family are `narrateStep('memory', …)` in
 * `action-panel/shared/narration.ts`; the two surfaces word it differently on
 * purpose and neither derives from the other.
 */
export function memoryToolTitle(command: string): string {
  if (MEMORY_UPDATE_COMMANDS.has(command)) return 'Memory updated';
  if (command === 'view') return 'Memory read';
  return 'Memory';
}

/**
 * The ONE file a memory row is about: the name it shows and the file it opens.
 *
 * Both come out of the same call on purpose. They were resolved separately for
 * one commit and immediately disagreed: a completed rename displayed its
 * DESTINATION and opened its SOURCE — the one name the rename had just removed,
 * so clicking the row opened a file that no longer existed.
 *
 * A rename is about where the file ended up. `path` is where it came from (see
 * the caller: `input.path` falls back to `input.old_path`), so a rename resolves
 * to `new_path`. That field can be absent — mid-stream, or on a malformed
 * call — and the source is then the only name the row can truthfully give, for
 * both the label and the click. Every other command already targets `path`.
 *
 * `subtitle` is `openPath` made relative, minus two cases that earn no line:
 * an empty path, and the memory ROOT — `memoryRelPath` answers `'memory'` for
 * it, which only repeats the title's noun ("Memory read · memory").
 */
export function memoryRowTarget(
  command: string,
  path: string,
  newPath: string,
): { openPath: string; subtitle: string | undefined } {
  const openPath = command === 'rename' ? newPath || path : path;
  const relative = memoryRelPath(openPath);
  return { openPath, subtitle: relative && relative !== 'memory' ? relative : undefined };
}

/**
 * Whether a memory file's extension reads as a document rather than source.
 *
 * `view` and `create` used to run every extension through `ToolCodeCard` —
 * highlighted, monospaced source. That is right for `.json` and friends, but a
 * `.md` memory note came out as its own markup: `**bold**`, `# heading`, list
 * dashes, all shown literally instead of rendered. `.mdx` gets the same
 * treatment; nothing else does.
 */
export function isMemoryMarkdown(ext: string): boolean {
  return ext === 'md' || ext === 'mdx';
}

/**
 * The markdown counterpart to `ToolCodeCard`: identical chrome — the
 * trigger-aligned indent, the `border`/`bg-popover` card, a copy affordance
 * over the raw text — with prose in place of a highlighted-source pane.
 *
 * A memory file can open with its own YAML frontmatter block, same as any
 * other markdown file (agent/skill definitions, notes with metadata headers).
 * `parseFrontmatter` passes content with none straight through unchanged, so
 * the common case — a plain note — pays nothing for the check; content that
 * does carry one gets the same small metadata card `file-viewer.tsx` renders
 * for it, instead of the parser reading the `---` fences as a stray rule and a
 * giant bold heading.
 *
 * `allowHtml={false}`: this reads as a stored FILE, not chat prose — embedded
 * markup shows as escaped text rather than becoming live DOM, matching the
 * file viewer's own markdown pane.
 */
function MemoryMarkdownCard({ code }: { code: string }) {
  const indent = useToolIndent();
  if (!code) return null;
  const { frontmatter, body } = parseFrontmatter(code);
  return (
    // Seam and indent gated together, exactly as `ToolCodeCard` gates them.
    <div className={cn(indent && 'mt-1.5', indent)}>
      <div className="border-border bg-popover relative rounded-md border">
        <CopyOverlay code={code}>
          {/* `MD_FLUSH_CLASSES` strips the nested code-block chrome (border,
              background, padding) a fenced code block would otherwise draw
              inside this already-bordered card; the fence's own `pre` keeps
              its `overflow-auto`, so a long line inside it scrolls instead of
              clipping or blowing out the panel's width. */}
          {/* `pr-11` mirrors `ToolCodeCard`: the same `CopyOverlay` button is
              pinned at `top-3 right-3`, and prose is what runs under it. */}
          <div data-scrollable className={cn('max-h-96 overflow-auto p-3 pr-11', MD_FLUSH_CLASSES)}>
            {frontmatter && <MarkdownFrontmatterCard data={frontmatter} />}
            <UnifiedMarkdown content={body} isStreaming={false} allowHtml={false} />
          </div>
        </CopyOverlay>
      </div>
    </div>
  );
}

export function MemoryTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  // Field selector, not the whole store: destructuring the hook subscribes this
  // row to every field, so opening ONE file preview re-rendered every memory row
  // on screen.
  const openPreview = useFilePreviewStore((s) => s.openPreview);

  const command = (input.command as string) || (streamingInput.command as string) || '';
  const path =
    (input.path as string) ||
    (streamingInput.path as string) ||
    (input.old_path as string) ||
    (streamingInput.old_path as string) ||
    '';
  const oldPath = (input.old_path as string) || '';
  const newPath = (input.new_path as string) || '';
  const fileText = (input.file_text as string) || (streamingInput.file_text as string) || '';
  const oldStr = (input.old_str as string) ?? (streamingInput.old_str as string) ?? '';
  const newStr = (input.new_str as string) ?? (streamingInput.new_str as string) ?? '';
  const insertText = (input.insert_text as string) || (streamingInput.insert_text as string) || '';
  const insertLine = input.insert_line ?? streamingInput.insert_line;

  const relPath = memoryRelPath(path);
  const ext = (relPath.split('.').pop() || 'md').toLowerCase();

  // The row's label and its click target, resolved once. `relPath` above stays
  // the BODY's name for the file — a rename's diff/label is about where the file
  // came from — so the two must not be collapsed into one.
  const { openPath, subtitle } = memoryRowTarget(command, path, newPath);

  // A directory listing has nothing to open. Asked of `openPath`, not `path`,
  // so it answers for the same file the click would actually receive.
  const isFileTarget = command !== 'view' || /\.\w+$/.test(openPath);

  // Both of these scan the whole output — `failed` copies it with `trim()`, and
  // `isErrorOutput` runs `JSON.parse` over it. They live in the body, so a
  // collapsed row paid for both on every re-render it did not ask for.
  const failed = useMemo(
    () =>
      !!output &&
      (/^no replacement was performed/i.test(output.trim()) || /did not appear/i.test(output)),
    [output],
  );
  const errored = useMemo(() => isErrorOutput(output), [output]);

  const isStreaming = (status === 'pending' && running) || status === 'running';

  const view = useMemo(
    () => (command === 'view' ? parseMemoryView(output, path) : null),
    [command, output, path],
  );

  let body: ReactNode = null;
  if (status === 'completed' && errored) {
    body = <ToolOutputFallback output={output} toolName="memory" />;
  } else if (command === 'view') {
    if (view?.type === 'dir') {
      body =
        view.entries.length > 0 ? (
          <ToolResultCard bodyClassName="px-2 py-1.5">
            {/* The card is bg-popover, so the fade must match it, not the page. */}
            <FadedScrollArea fadeColor="from-popover">
              {view.entries.map((entry, i) => {
                const isLast = i + 1 >= view.entries.length;
                const name = memoryRelPath(entry.path);
                return (
                  <div key={entry.path} className="flex gap-2.5">
                    <div
                      className={cn('flex min-w-0 flex-1 items-center gap-2', !isLast && 'pb-3')}
                    >
                      <span className="text-muted-foreground truncate font-mono text-xs">
                        {name}
                      </span>
                      <span className="text-muted-foreground/50 ml-auto shrink-0 text-xs tabular-nums">
                        {entry.size}
                      </span>
                    </div>
                  </div>
                );
              })}
            </FadedScrollArea>
          </ToolResultCard>
        ) : (
          <ToolResultCard>
            <ToolEmptyState
              message={tI18nHardcoded.raw(
                'autoFeaturesSessionToolRenderersJsxAttrMessageMemoryIsEmptyc797bb83',
              )}
            />
          </ToolResultCard>
        );
    } else if (view?.type === 'file' && view.content) {
      body = isMemoryMarkdown(ext) ? (
        <MemoryMarkdownCard code={view.content} />
      ) : (
        <ToolCodeCard code={view.content} language={ext} />
      );
    } else if (output) {
      body = <ToolOutputFallback output={output} toolName="memory" />;
    } else {
      body = (
        <ToolResultCard>
          <ToolEmptyState message={isStreaming ? 'Reading memory…' : 'Nothing to show.'} />
        </ToolResultCard>
      );
    }
  } else if (command === 'create') {
    body = fileText ? (
      isMemoryMarkdown(ext) ? (
        <MemoryMarkdownCard code={fileText} />
      ) : (
        <ToolCodeCard code={fileText} language={ext} />
      )
    ) : (
      <ToolResultCard>
        <ToolEmptyState message={isStreaming ? 'Writing memory…' : 'No content.'} />
      </ToolResultCard>
    );
  } else if (command === 'str_replace') {
    body = failed ? (
      <ToolError error={output} toolName="memory" />
    ) : oldStr || newStr ? (
      // `bodyClassName="max-h-96"` used to raise this diff above the card's old
      // `max-h-[19rem]`; that IS the card's cap now, so the override is gone.
      <ToolResultCard>
        <InlineDiffView oldValue={oldStr} newValue={newStr} filename={relPath} />
      </ToolResultCard>
    ) : (
      <ToolResultCard>
        <ToolEmptyState
          message={tI18nHardcoded.raw(
            'autoFeaturesSessionToolRenderersJsxAttrMessageNoChanges0aa33a4a',
          )}
        />
      </ToolResultCard>
    );
  } else if (command === 'insert') {
    body =
      !insertText && insertLine == null ? (
        <ToolResultCard>
          <ToolEmptyState
            message={tI18nHardcoded.raw(
              'autoFeaturesSessionToolRenderersJsxAttrMessageNothingInsertede2d2969f',
            )}
          />
        </ToolResultCard>
      ) : (
        <ToolResultCard>
          {insertLine != null && (
            <div className="text-muted-foreground/70 px-3 pt-2 text-xs">
              {tI18nHardcoded.raw('autoFeaturesSessionToolRenderersJsxTextInsertedAtLine1bc36059')}
              {String(insertLine)}
            </div>
          )}
          {insertText ? <ToolCode code={insertText} language={ext} /> : null}
        </ToolResultCard>
      );
  } else if (command === 'rename') {
    body = (
      <ToolResultCard>
        <div className="text-muted-foreground/80 flex flex-wrap items-center gap-1.5 px-2 py-1.5 font-mono text-xs">
          <span className="truncate">{memoryRelPath(oldPath || path)}</span>
          <ChevronRight className="text-muted-foreground/40 size-3 shrink-0" />
          <span className="text-foreground/80 truncate">{memoryRelPath(newPath)}</span>
        </div>
      </ToolResultCard>
    );
  } else if (command === 'delete') {
    body = (
      <ToolResultCard>
        <div className="text-muted-foreground/70 flex items-center gap-1.5 px-2 py-1.5 text-xs">
          <Trash2 className="size-3 shrink-0" />
          <span className="truncate font-mono">{relPath}</span>
        </div>
      </ToolResultCard>
    );
  } else if (output) {
    body = <ToolOutputFallback output={output} toolName="memory" />;
  }

  return (
    <BasicTool
      icon={<Brain className="size-3.5 shrink-0" />}
      trigger={{
        title: memoryToolTitle(command),
        subtitle,
      }}
      onSubtitleClick={
        openPath && isFileTarget && command !== 'delete' ? () => openPreview(openPath) : undefined
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {body}
    </BasicTool>
  );
}
ToolRegistry.register('memory', MemoryTool);
ToolRegistry.register('oc-memory', MemoryTool);
