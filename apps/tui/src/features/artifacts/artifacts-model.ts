/**
 * The Artifacts screen's pure data shapes.
 *
 * The SDK root does not export the `Artifact` wire type, so `ArtifactLike` is
 * the structural subset the screen reads. A real `Artifact` is assignable.
 */

export interface ArtifactLike {
  artifact_id: string;
  title: string;
  description: string | null;
  type: 'doc' | 'html';
  path: string;
  entry: string;
  visibility: 'private' | 'project' | 'public';
  pinned: boolean;
  can_manage: boolean;
  created_by: { name: string | null; email: string | null };
  created_by_session_id: string | null;
  web_url: string;
  public_url: string | null;
  updated_at: string;
}

export interface ArtifactRow {
  id: string;
  title: string;
  /** `doc` or `html`. */
  kind: string;
  path: string;
  entry: string;
  description: string;
  visibility: string;
  pinned: boolean;
  canManage: boolean;
  /** Empty when the API gave no name or email. */
  author: string;
  sessionId: string | null;
  webUrl: string;
  publicUrl: string | null;
  updatedMs: number;
}

export function toArtifactRow(artifact: ArtifactLike, webBaseUrl: string, projectId: string): ArtifactRow {
  const updated = Date.parse(artifact.updated_at);
  return {
    id: artifact.artifact_id,
    title: artifact.title,
    kind: artifact.type,
    path: artifact.path,
    entry: artifact.entry,
    description: artifact.description ?? '',
    visibility: artifact.visibility,
    pinned: artifact.pinned,
    canManage: artifact.can_manage,
    author: artifact.created_by.name || artifact.created_by.email || '',
    sessionId: artifact.created_by_session_id,
    webUrl: artifactWebUrl(artifact.web_url, webBaseUrl, projectId, artifact.artifact_id),
    publicUrl: artifact.public_url,
    updatedMs: Number.isNaN(updated) ? Number.NaN : updated,
  };
}

/**
 * The link a browser opens. The API's `web_url` wins when it is absolute; a
 * relative one is joined to the web origin; none falls back to the route the
 * web app serves (`/projects/<id>/artifacts/<artifact_id>`).
 */
export function artifactWebUrl(
  webUrl: string | null | undefined,
  webBaseUrl: string,
  projectId: string,
  artifactId: string,
): string {
  const base = webBaseUrl.replace(/\/+$/, '');
  if (webUrl && /^https?:\/\//i.test(webUrl)) return webUrl;
  if (webUrl) return `${base}${webUrl.startsWith('/') ? '' : '/'}${webUrl}`;
  return `${base}/projects/${projectId}/artifacts/${artifactId}`;
}

/** Pinned first, then as the API ordered them (newest change first). */
export function orderRows(rows: readonly ArtifactRow[]): ArtifactRow[] {
  return [...rows.filter((row) => row.pinned), ...rows.filter((row) => !row.pinned)];
}

/** Case-insensitive match on the title, the path or the author. */
export function filterArtifactRows(rows: readonly ArtifactRow[], query: string): ArtifactRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter(
    (row) =>
      row.title.toLowerCase().includes(needle) ||
      row.path.toLowerCase().includes(needle) ||
      row.author.toLowerCase().includes(needle),
  );
}

/** The phrase for who can open an artifact, as the web words it. */
export const VISIBILITY_PHRASE: Record<string, string> = {
  private: 'Just you and people you share it with',
  project: 'Whole team',
  public: 'Anyone with the link',
};

/** The one-line state shown in place of the list, or `null` when it is usable. */
export function unavailableReason(input: {
  projectId: string | null;
  flagLoading: boolean;
  flagEnabled: boolean;
}): string | null {
  if (!input.projectId) return 'No project selected. Pick a project to see its artifacts.';
  if (input.flagLoading) return null;
  if (!input.flagEnabled) return 'Artifacts are off for this project. Turn on the `artifacts` flag.';
  return null;
}
