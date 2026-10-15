import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(`${import.meta.dir}/use-trigger-mutations.ts`, 'utf8');
const page = readFileSync(`${import.meta.dir}/../schedule-view.tsx`, 'utf8');
const agent = readFileSync(
  `${import.meta.dir}/../../../features/workspace/capabilities/agents/agent-triggers-section.tsx`,
  'utf8',
);

describe('shared trigger mutation seam', () => {
  test('both hosts use shared mutations and retain the same trigger invalidation key', () => {
    for (const host of [page, agent]) {
      expect(host).toContain('const { run, remove } = useTriggerMutations({');
      expect(host).toContain('qk.project.triggers(projectId)');
      expect(host).not.toContain('fireProjectTrigger');
      expect(host).not.toContain('deleteProjectTrigger');
      expect(host).toMatch(
        /onRemoved: \(\) => \{\s*setDeleteTarget\(null\);\s*setSelectedSlug\(null\);/,
      );
    }
  });
  test('hosts preserve distinct failed-run copy and localized versus legacy deletion nouns', () => {
    expect(page).toContain("runFailureKey: 'text9c18cb990345'");
    expect(agent).toContain("runFailureKey: 'textfc56800b00af'");
    expect(page).toContain('deletedNoun: (trigger) => kindCopy[trigger.type as TriggerKind].noun');
    expect(agent).toContain(
      "isTriggerKind(trigger.type) ? KIND_COPY[trigger.type as TriggerKind].noun : 'trigger'",
    );
  });
  test('shared hook retains run status, error fallbacks, deletion copy, and success-only invalidation', () => {
    expect(source).toContain('fireProjectTrigger(projectId, trigger.slug)');
    expect(source).toContain('deleteProjectTrigger(projectId, trigger.slug)');
    expect(source).toContain("res.status === 'fired'");
    expect(source).toContain("res.status === 'queued'");
    expect(source).toContain('res.session_id.slice(0, 8)');
    expect(source).toContain("res.reason ?? tI18nComplete.raw('text17cf41bd6a6f')");
    expect(source).toContain('tI18nComplete.raw(runFailureKey), { description: res.error }');
    expect(source).toContain(
      "err instanceof Error ? err.message : tI18nComplete.raw('textfc56800b00af')",
    );
    expect(source).toContain(
      "err instanceof Error ? err.message : tI18nComplete.raw('text76bf191d6426')",
    );
    expect(source).toMatch(/onRemoved\(\);\s*void invalidate\(\);/);
    expect(source.match(/void invalidate\(\)/g)).toHaveLength(2);
  });
});
