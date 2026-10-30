/**
 * The Repo screen: the project's git repository, files and history.
 *
 * The data half. Every read is a method on the one `kortix()` client
 * (`project(id).files` and `.git`); the view owns pixels and keys. Read-only.
 * The API gates reads on `project.file.read`: a 403 reaches the view as the
 * error line of the tree, with its status code.
 */

import { useMemo } from 'react';

import { kortix } from '../../kortix.ts';
import { copyToClipboard } from '../../lib/clipboard.ts';
import { openUrl } from '../../lib/open-url.ts';
import { theme } from '../../theme.ts';
import { entryToNode, repoPath, repoWebUrl, toBranchRow, toCommitRow } from './repo-model.ts';
import { type RepoLoaders, RepoView } from './repo-view.tsx';

/** Commits per history load. The web's panel loads the same order of size. */
const HISTORY_LIMIT = 100;

export interface RepoScreenProps {
  projectId: string | null;
  accountId: string | null;
  sessionId: string | null;
  focused: boolean;
  width: number;
  height: number;
  webBaseUrl: string;
  onBack(): void;
  onOpenSession(sessionId: string): void;
  onToast(message: string, kind?: 'info' | 'error'): void;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' && error ? error : 'Unknown error';
}

export function RepoScreen({
  projectId,
  accountId: _accountId,
  sessionId: _sessionId,
  focused,
  width,
  height,
  webBaseUrl,
  onBack,
  onOpenSession: _onOpenSession,
  onToast,
}: RepoScreenProps) {
  const loaders = useMemo<RepoLoaders | null>(() => {
    if (!projectId) return null;
    const project = kortix().project(projectId);
    return {
      async listDirectory(path, ref) {
        const listing = await project.files.listDirectory({
          path: repoPath(path) || undefined,
          ref,
        });
        return { nodes: listing.entries.map(entryToNode), truncated: listing.truncated };
      },
      readFile: (path, ref) => project.files.read(repoPath(path), ref),
      async history(path, ref) {
        if (path) {
          const result = await project.files.history(path, { ref, limit: HISTORY_LIMIT });
          return result.commits.map(toCommitRow);
        }
        // `git.commits()` takes no options, so it cannot read another branch.
        if (ref) throw new Error('Repository history reads the default branch. Select a file.');
        return (await project.git.commits()).commits.map(toCommitRow);
      },
      async branches() {
        const result = await project.git.branches();
        return {
          defaultBranch: result.default_branch,
          branches: result.branches.map(toBranchRow),
        };
      },
    };
  }, [projectId]);

  if (!projectId || !loaders) {
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.faint}>No project selected. Pick a project to read its repository.</text>
      </box>
    );
  }

  return (
    <RepoView
      loaders={loaders}
      focused={focused}
      width={width}
      height={height}
      onBack={onBack}
      onToast={onToast}
      onOpenWeb={() => {
        const url = repoWebUrl(webBaseUrl, projectId);
        openUrl(url).then(
          () => onToast(`Opened ${url}`),
          (error: unknown) => onToast(errorText(error), 'error'),
        );
      }}
      onCopy={(text, what) => {
        void copyToClipboard(text).then((result) => {
          if (result.ok) onToast(`Copied ${what}`);
          else onToast(`Copy failed: ${result.error ?? 'no clipboard tool'}`, 'error');
        });
      }}
    />
  );
}
