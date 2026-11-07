import { describe, expect, test } from 'bun:test';

import { parseArtifactUrl } from './artifacts';

const P = '11111111-2222-4333-8444-555555555555';
const A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('parseArtifactUrl', () => {
  test('an app link names its project and artifact, on any Kortix host', () => {
    expect(parseArtifactUrl(`https://kortix.com/workspaces/${P}/artifacts/${A}`)).toEqual({ projectId: P, artifactId: A });
    expect(parseArtifactUrl(`http://localhost:3000/workspaces/${P}/artifacts/${A}/`)).toEqual({ projectId: P, artifactId: A });
  });

  test('the older /projects app link parses like the /workspaces one', () => {
    expect(parseArtifactUrl(`https://kortix.com/projects/${P}/artifacts/${A}`)).toEqual({ projectId: P, artifactId: A });
    expect(parseArtifactUrl(`/de/projects/${P}/artifacts/${A}/`)).toEqual({ projectId: P, artifactId: A });
  });

  test('ids come back lower-case', () => {
    expect(parseArtifactUrl(`https://kortix.com/workspaces/${P.toUpperCase()}/artifacts/${A.toUpperCase()}`)).toEqual({
      projectId: P,
      artifactId: A,
    });
  });

  test('a public share link names the artifact and no project', () => {
    expect(parseArtifactUrl(`https://kortix.com/share/artifact/${A}`)).toEqual({ projectId: null, artifactId: A });
  });

  test('a relative app path parses', () => {
    expect(parseArtifactUrl(`/workspaces/${P}/artifacts/${A}`)).toEqual({ projectId: P, artifactId: A });
  });

  test('any other URL is null', () => {
    expect(parseArtifactUrl('https://example.com/')).toBeNull();
    expect(parseArtifactUrl(`https://kortix.com/workspaces/${P}/sessions/${A}`)).toBeNull();
    expect(parseArtifactUrl(`https://kortix.com/workspaces/${P}/artifacts/not-a-uuid`)).toBeNull();
    expect(parseArtifactUrl('not a url at all ::')).toBeNull();
  });
});
