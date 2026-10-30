import { describe, expect, test } from 'bun:test';

import { artifactFrameKey, parseArtifactUrl } from './frame-policy';

const P = '5fc76fcb-77cd-49d0-8d3b-d6e0eec6f1af';
const A = '091862e9-4937-4e9b-925e-b8f6027feb28';

describe('parseArtifactUrl', () => {
  test('an app link names its project and artifact, on any Kortix host and locale', () => {
    expect(parseArtifactUrl(`https://dev.kortix.com/projects/${P}/artifacts/${A}`)).toEqual({
      projectId: P,
      artifactId: A,
    });
    expect(parseArtifactUrl(`http://localhost:3000/de/projects/${P}/artifacts/${A}/`)).toEqual({
      projectId: P,
      artifactId: A,
    });
  });

  test('a public link names the artifact alone', () => {
    expect(parseArtifactUrl(`https://kortix.com/share/artifact/${A}`)).toEqual({
      projectId: null,
      artifactId: A,
    });
  });

  test('any other URL is not an artifact', () => {
    expect(parseArtifactUrl(`https://dev.kortix.com/projects/${P}/artifacts`)).toBeNull();
    expect(parseArtifactUrl(`https://dev.kortix.com/projects/${P}/sessions/${A}`)).toBeNull();
    expect(parseArtifactUrl('not a url')).toBeNull();
  });
});

test('annotated frames have a separate pool key for the same immutable version', () => {
  const artifact = { artifact_id: A, updated_at: 'now' };
  expect(artifactFrameKey(artifact, 'commit')).toBe(`artifact:${A}:commit`);
  expect(artifactFrameKey(artifact, 'commit', true)).toBe(`artifact:${A}:commit:annotate`);
  expect(artifactFrameKey(artifact, null, true)).not.toBe(artifactFrameKey(artifact));
});
