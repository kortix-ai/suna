interface Author { userId: string | null; sessionId: string | null }
interface Viewer { userId: string; sessionId: string | null; canComment: boolean; canEdit: boolean; manageAny: boolean }

export function artifactCommentPermissions(viewer: Viewer, creator: Author, sentSessionId: string | null, deleted: boolean, historical: boolean) {
  const owns = (author: Author) => viewer.sessionId ? author.sessionId === viewer.sessionId : author.sessionId === null && author.userId === viewer.userId;
  const writable = viewer.canComment && !deleted && !historical;
  return {
    can_reply: writable,
    can_resolve: writable && (owns(creator) || viewer.manageAny || viewer.canEdit || !!viewer.sessionId && sentSessionId === viewer.sessionId),
    comment: (author: Author, tombstone: boolean) => ({ can_edit: writable && !tombstone && owns(author), can_delete: writable && !tombstone && (owns(author) || viewer.manageAny) }),
  };
}
