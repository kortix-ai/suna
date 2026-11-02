import type { ArtifactCommentAnchor } from '@kortix/shared/artifact-comments';

export function artifactAgentChainPaused(recentKinds: readonly string[]): boolean {
  return recentKinds.length >= 5 && recentKinds.slice(0, 5).every((kind) => kind === 'session');
}

export function artifactCommentPrompt(
  artifact: { artifactId: string; title: string; path: string; version: string },
  threads: Array<{ thread_id: string; anchor: ArtifactCommentAnchor; comments: Array<{ body: string; author_user_id: string | null; author_session_id: string | null; screenshot_url?: string }> }>,
): string {
  const anchorText = (anchor: ArtifactCommentAnchor) => {
    if (anchor.type === 'text') return `Selected text: ${JSON.stringify(anchor.quote)}`;
    if (anchor.type === 'none') return 'The whole Artifact';
    return `Page anchor: ${JSON.stringify(anchor)}`;
  };
  return [
    'Review the following Artifact comment threads.',
    `Artifact id: ${artifact.artifactId}`,
    `Title: ${artifact.title}`,
    `Files path: ${artifact.path}`,
    `Current entry_version: ${artifact.version}`,
    '',
    ...threads.flatMap((thread) => [
      `Thread ${thread.thread_id}`, anchorText(thread.anchor),
      ...thread.comments.filter((comment) => comment.body).flatMap((comment) => [
        `${comment.author_session_id ? `Agent session ${comment.author_session_id}` : `Person ${comment.author_user_id}`}: ${comment.body}`,
        ...(comment.screenshot_url ? [`Screenshot (Artifact API authentication required): ${comment.screenshot_url}`] : []),
      ]), '',
    ]),
    `Pull the current Artifact: kortix artifacts pull ${artifact.artifactId} ./work`,
    `Edit the file, then publish with --id ${artifact.artifactId} --base-version ${artifact.version}.`,
    'If the version conflicts, pull again and merge the changes.',
    'For each addressed thread, reply with the change in one sentence, then resolve it.',
    ...threads.flatMap((thread) => [`kortix artifacts reply ${thread.thread_id} "<change>"`, `kortix artifacts resolve ${thread.thread_id}`]),
    'Never resolve a thread you did not address. Reply with a question when you need a person.',
    'Stop when the thread is paused or says Waiting for a person.',
  ].join('\n');
}
