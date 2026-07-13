import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const boundarySource = readFileSync(join(import.meta.dir, 'sandbox-loading-boundary.tsx'), 'utf8');
const projectLayoutSource = readFileSync(
  join(import.meta.dir, '../../app/(app)/projects/[id]/layout.tsx'),
  'utf8',
);
const projectAccessSource = readFileSync(
  join(import.meta.dir, '../../components/projects/project-access-boundary.tsx'),
  'utf8',
);

describe('session navigation loading boundaries', () => {
  test('runtime-not-ready retries never render the full-page ASCII logo', () => {
    expect(boundarySource).toContain('return null;');
    expect(boundarySource).not.toContain('KortixHyperLogo');
    expect(boundarySource).not.toContain('min-h-[50vh]');
  });

  test('the project shell cannot be replaced by a route-wide sandbox fallback', () => {
    expect(projectLayoutSource).not.toContain('SandboxLoadingBoundary');
    expect(projectLayoutSource).toContain('<ProjectAccessBoundary projectId={projectId}>');
    expect(projectLayoutSource).toContain('<SessionStreamKeeper projectId={projectId} />');
  });

  test('first project access still keeps its intentional full-page loader', () => {
    expect(projectAccessSource).toContain('function ProjectAccessLoading()');
    expect(projectAccessSource).toContain('<KortixHyperLogo');
    expect(projectAccessSource).toContain('min-h-screen');
  });
});
