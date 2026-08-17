'use client';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  BasicTool,
  MD_FLUSH_CLASSES,
  parseJsonFailure,
  partInput,
  partOutput,
  partStatus,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { ToolSection } from '@/features/session/tool/shared/output-block';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import {
  extractSkillContent,
  extractSkillFiles,
  skillDocumentPath,
  skillInputDir,
} from '@/features/session/tool/shared/skill-helpers';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { cn } from '@/lib/utils';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { FileDashedIcon, FileTextIcon as FileText } from '@phosphor-icons/react';
import { useCallback, useMemo } from 'react';

/** A YAML frontmatter block at the very top of a document. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A YAML block-scalar header and nothing else — `|`, `>`, and their
 *  indentation/chomping indicators in either order (`|-`, `>2`, `|2-`, `>-2`). */
const BLOCK_SCALAR_HEADER = /^[|>](?:[+-]?\d?|\d?[+-]?)$/;

/**
 * The skill's one-line purpose, or '' when the output does not carry one.
 *
 * A skill's `SKILL.md` opens with YAML frontmatter whose `description:` is the
 * one sentence the model reads to decide whether the skill applies — see any
 * file under `packages/starter/templates/managed/.kortix/opencode/skills/`. When
 * the tool echoes that document, the same line is the best subtitle this row can
 * have; when it does not, the row carries a title alone. Nothing is fetched and
 * no second source is consulted: the subtitle is simply omitted.
 *
 * Only the FIRST sentence survives. Those descriptions are written for routing,
 * not for reading — `kortix-computer`'s runs past 700 characters and spends most
 * of them on "Load this when …" — so the whole string in a one-line row is a
 * paragraph the reader must scan to find the four words that say what it does.
 */
export function parseSkillPurpose(content: string): string {
  const frontmatter = content.trimStart().match(FRONTMATTER);
  if (!frontmatter) return '';

  const line = frontmatter[1].match(/^description[ \t]*:[ \t]*(.+)$/im);
  if (!line) return '';

  const raw = line[1].trim();
  // A YAML block scalar puts the value on the FOLLOWING lines: `description: |`
  // and `description: >` (with optional indentation/chomping indicators —
  // `|-`, `>2`, `|2-`) carry nothing on the `description:` line itself. Read as
  // a plain value, the header became a one-character subtitle: a row titled
  // "webapp" with "|" under it. Only this line is ever parsed, so the honest
  // answer is no subtitle — the row already reads fine without one.
  if (BLOCK_SCALAR_HEADER.test(raw)) return '';

  const quoted = raw.match(/^(['"])([\s\S]*)\1$/);
  const value = (quoted ? quoted[2] : line[1]).trim().replace(/\s+/g, ' ');
  if (!value) return '';

  return value.split(/(?<=[.!?])\s+/)[0] ?? value;
}

/**
 * A skill call is a disclosure row: the name, what it is for, what it loaded.
 *
 * This row used to be a plain button that jumped straight to `SKILL.md` in the
 * file preview. That put a navigation — the only one in the transcript that
 * leaves the conversation without saying so — on a step the reader is usually
 * just skimming past, and it hid the one fact they actually want, which is what
 * the skill brought into the turn. So the row expands in place like every other
 * step, and the jump to the document is an explicit action inside it.
 *
 * The subtitle carries the skill's purpose (see `parseSkillPurpose`), so the
 * body never repeats it: the frontmatter is stripped out of the markdown below.
 */
export function SkillTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);
  const output = partOutput(part);

  const rawName = typeof input.name === 'string' ? input.name.trim() : '';
  // `skillDocumentPath` refuses the 'skill' placeholder as a directory name, so
  // the fallback is safe to pass through. The row shows 'Skill' instead — a
  // lowercase placeholder read as a real skill called "skill".
  const skillName = rawName || 'skill';
  // `input.dir` is only one of the names the runtime may use — see `skillInputDir`.
  const skillDir = skillInputDir(input);

  const skillContent = useMemo(() => extractSkillContent(output), [output]);
  const skillFiles = useMemo(() => extractSkillFiles(output), [output]);
  const purpose = useMemo(() => parseSkillPurpose(skillContent), [skillContent]);

  const markdownContent = useMemo(() => {
    return skillContent
      .trimStart()
      .replace(FRONTMATTER, '')
      .replace(/<skill_files>[\s\S]*?<\/skill_files>/, '')
      .replace(/Base directory:.*$/m, '')
      .replace(/Note:.*relative to the base directory.*$/m, '')
      .trim();
  }, [skillContent]);

  /**
   * A skill opens where a file opens.
   *
   * The document behind this row goes to the session's detail view, exactly as
   * clicking a file in a read row does — not to a second right-hand `Sheet` with
   * its own header, its own scroll and its own copy of the markdown.
   */
  const openPreview = useFilePreviewStore((s) => s.openPreview);
  /**
   * The document behind the row.
   *
   * The NAME is what resolves it. Earlier versions read only the payload — an
   * `input.dir`, then a tag attribute, then a `Base directory:` line — and a
   * real call carries none of those, so the path came out null and the action
   * was missing. The skill's location was never the runtime's to tell us: this
   * product installs skills at `.kortix/opencode/skills/<name>/`. See
   * `skillDocumentPath`.
   */
  const docPath = useMemo(
    () => skillDocumentPath(output, skillDir, skillName),
    [output, skillDir, skillName],
  );
  const openSkillDoc = useCallback(() => {
    if (docPath) openPreview(docPath);
  }, [openPreview, docPath]);

  const isCompleted = status === 'completed';
  const failure = useMemo(
    () => (isCompleted ? parseJsonFailure(output) : null),
    [isCompleted, output],
  );

  const hasBody = isCompleted && (markdownContent || skillFiles.length > 0 || docPath);

  return (
    <BasicTool
      icon={<FileDashedIcon />}
      trigger={{ title: rawName || 'Skill', subtitle: purpose || undefined }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
      badge={isCompleted && skillFiles.length > 0 ? `${skillFiles.length} files` : undefined}
    >
      {failure ? (
        <ToolOutputFallback output={output} toolName="skill" />
      ) : hasBody ? (
        <div className="flex flex-col gap-2">
          <div
            data-scrollable
            className={cn('relative max-h-96 overflow-auto px-1', MD_FLUSH_CLASSES)}
          >
            {markdownContent && <UnifiedMarkdown content={markdownContent} isStreaming={false} />}
            {skillFiles.length > 0 && (
              <>
                {markdownContent && <Separator className="my-4" />}
                {/* The sanctioned section label, not a `text-sm` uppercase
                    heading. The row above this body already names the skill
                    and badges "N files", so a heading at nearly the trigger's
                    own weight said the same thing twice, louder. */}
                <ToolSection label="Files">
                  <ul className="space-y-0.5">
                    {skillFiles.map((f) => (
                      <li
                        key={f}
                        className="text-muted-foreground flex items-center gap-1.5 font-mono text-xs"
                      >
                        <FileText className="text-muted-foreground size-3 shrink-0" />
                        <span className="truncate">{f}</span>
                      </li>
                    ))}
                  </ul>
                </ToolSection>
              </>
            )}
          </div>
          {/* Outside the scroll box on purpose: a long skill document must not
              push the only way to open it out of reach. */}
          {docPath && (
            <div className="px-1">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={openSkillDoc}
                title={docPath}
                className="text-muted-foreground hover:text-foreground -ml-1.5 h-6 gap-1.5 px-1.5 text-xs"
              >
                <FileText className="size-3" />
                Open skill doc
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('skill', SkillTool);
