/**
 * L4: a workflow becomes a Kortix skill. `draftSkill` writes a SKILL.md from
 * the canonical procedure, its variants and decision points (no literal
 * values: steps carry variable names only). `publishSkill` commits it to the
 * project a person picks — the one place Capture touches a project.
 */
import { captureWorkflows } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { commitRepoFile } from '../projects/lib/trigger-manifest';
import { db } from '../shared/db';
import type { WorkflowRow } from './intelligence';

export interface WorkflowStep {
  index: number;
  verb: string;
  object: string;
  app: string | null;
  params?: string | null;
  variables?: string[];
  decision?: { question: string; variant: string; share: number } | null;
}

export interface WorkflowVariant {
  key: string;
  name: string;
  runs: number;
  share: number;
  steps_count: number;
  /** 1-based indexes of the steps that differ from the canonical path. */
  differs: number[];
  note: string;
}

/** `refund-damaged-order` from "Refund a damaged-order claim": lower case, a–z 0–9 and dashes, at most 64. */
export function skillSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
      .replace(/-+$/, '') || 'workflow'
  );
}

/** Literal values that must never reach a skill: emails, long digit runs, URLs with query strings. */
const LITERAL = /[\w.+-]+@[\w-]+\.[\w.]+|\b\d{6,}\b|https?:\/\/\S+\?\S+/;

export function draftSkill(w: WorkflowRow, name = skillSlug(w.name)) {
  const steps = w.steps as unknown as WorkflowStep[];
  const variants = w.variants as unknown as WorkflowVariant[];
  const inputs = [...new Set(steps.flatMap((s) => s.variables ?? []))];
  const lines = steps.map((s, i) => {
    const vars = (s.variables ?? []).map((v) => `{${v}}`).join(', ');
    const where = s.app ? ` in ${s.app}` : '';
    const step = `${i + 1}. ${s.verb} ${s.object}${vars ? ` (${vars})` : ''}${where}.${s.params ? ` ${s.params}.` : ''}`;
    return s.decision ? `${step}\n   If ${s.decision.question}, follow variant ${s.decision.variant} below.` : step;
  });
  const variantLines = variants
    .filter((v) => v.key !== 'A')
    .map((v) => `- **${v.key} · ${v.name}** (${Math.round(v.share * 100)}% of runs): ${v.note}`);
  const description = `${w.goal ?? w.name}. Use when this task comes up.`.replace(/\s+/g, ' ');
  const markdown = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    `# ${w.name}`,
    '',
    w.goal ? `Goal: ${w.goal}` : null,
    w.outcome ? `Done when: ${w.outcome}` : null,
    inputs.length ? `Inputs: ${inputs.map((v) => `{${v}}`).join(', ')}` : null,
    '',
    '## Steps',
    '',
    ...lines,
    ...(variantLines.length ? ['', '## Variants', '', ...variantLines] : []),
    '',
    `Needs: ${w.apps.join(', ') || 'no app'}${w.apps.length ? ' (connectors with write access)' : ''}.`,
    '',
    `Learned from ${w.runsTotal} recorded runs by Kortix Capture.`,
    '',
  ]
    .filter((line) => line !== null)
    .join('\n');
  const coveredVariants = variants.filter((v) => v.key === 'A' || markdown.includes(` ${v.key} `)).length;
  return {
    name,
    markdown,
    inputs,
    checks: [
      { ok: coveredVariants === variants.length, label: `All ${variants.length} variants covered` },
      { ok: !LITERAL.test(markdown), label: 'No literal customer values left in the draft' },
    ],
  };
}

type ProjectRow = Parameters<typeof commitRepoFile>[0];

/** Commit `skills/<name>/SKILL.md` to the project's default branch and mark the workflow exported. */
export async function publishSkill(input: {
  workflow: WorkflowRow;
  project: ProjectRow;
  name: string;
  markdown: string;
  by: string;
}): Promise<{ ok: true; skill: Record<string, unknown> } | { error: string; status: number }> {
  const path = `skills/${input.name}/SKILL.md`;
  const committed = await commitRepoFile(input.project, path, input.markdown, `capture: publish skill ${input.name} from workflow "${input.workflow.name}"`);
  if (!('ok' in committed)) return committed;
  const skill = {
    project_id: input.project.projectId,
    path,
    name: input.name,
    exported_at: new Date().toISOString(),
    exported_by: input.by,
  };
  await db
    .update(captureWorkflows)
    .set({ status: 'exported', skill, updatedAt: new Date() })
    .where(eq(captureWorkflows.workflowId, input.workflow.workflowId));
  return { ok: true, skill };
}
