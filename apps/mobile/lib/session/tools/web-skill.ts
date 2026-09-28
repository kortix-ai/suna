/**
 * Pure logic behind `components/session/tool/tools/skill-tool.tsx`.
 *
 * Ported from apps/web `tool/tools/skill-tool.tsx`: the trigger (title
 * "Skill", subtitle the skill name), the `SKILL.md` path the subtitle opens,
 * the document with its runtime notes stripped, the listed files, and the
 * JSON-failure verdict. Parsing comes from `@kortix/sdk`.
 */

import {
  extractSkillContent,
  extractSkillFiles,
  parseJsonFailure,
  skillDocumentPath,
  skillInputDir,
  type ParsedJsonFailure,
} from '@kortix/sdk';
import { skillDocumentBody } from '@kortix/shared/tool-output';

export interface SkillBody {
  trigger: { title: string; subtitle: string | undefined };
  /** `SKILL.md` to open from the subtitle; `null` offers no tap. */
  docPath: string | null;
  /** The document markdown (frontmatter included), runtime notes removed. */
  document: string;
  files: string[];
  failure: ParsedJsonFailure | null;
  hasBody: boolean;
}

export function skillBody(input: Record<string, unknown>, output: string, status: string): SkillBody {
  const rawName = typeof input.name === 'string' ? input.name.trim() : '';
  // `skillDocumentPath` refuses the 'skill' placeholder as a directory name.
  const skillName = rawName || 'skill';
  const document = skillDocumentBody(extractSkillContent(output));
  const files = extractSkillFiles(output);
  const isCompleted = status === 'completed';

  return {
    trigger: { title: 'Skill', subtitle: rawName || undefined },
    docPath: skillDocumentPath(output, skillInputDir(input), skillName),
    document,
    files,
    failure: isCompleted ? parseJsonFailure(output) : null,
    hasBody: isCompleted && Boolean(document || files.length > 0),
  };
}
