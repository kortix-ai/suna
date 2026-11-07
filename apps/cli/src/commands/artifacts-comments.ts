// `kortix artifacts` comment verbs: comments, comment, reply, resolve, reopen
// and activity.
import {
  createArtifactComment,
  getArtifactCommentThread,
  listArtifactActivity,
  listArtifactComments,
  listArtifactVersions,
  readArtifactFile,
  replyArtifactComment,
  setArtifactCommentStatus,
  type ArtifactCommentAuthor,
} from '@kortix/sdk';
import { fail, missing } from '../command-helpers.ts';
import { pad, status } from '../style.ts';
import { artifactCommentAnchor } from './artifact-comment-anchor.ts';
import type { ArtifactsRun } from './artifacts-run.ts';

function commentAuthor(author: ArtifactCommentAuthor): string {
  return author.kind === 'session' ? `${author.agent_name ?? 'Agent'}${author.title ? ` · ${author.title}` : ''} (${author.session_id})` : author.name ?? author.user_id;
}


export async function artifactsComments(sub: string, { pid, f, a0, a1, resolve, out }: ArtifactsRun): Promise<number> {
  switch (sub) {
    case 'comments': {
      const id = await resolve(a0);
      if (!id) return a0 ? 1 : missing('an artifact id');
      const threads = await listArtifactComments(pid, id, { status: f.all ? 'all' : f.resolved ? 'resolved' : 'open' });
      if (f.json) return out(threads, '');
      if (!threads.length) return out(null, 'No matching comment threads.');
      for (const thread of threads) {
        const delivery = thread.agent_state === 'paused'
          ? thread.agent_error ? ` · Delivery failed: ${thread.agent_error}` : ' · Waiting for a person'
          : '';
        process.stdout.write(`${thread.thread_id}  ${thread.status}${delivery}\n`);
        for (const comment of thread.comments) process.stdout.write(`  ${commentAuthor(comment.author)}: ${comment.deleted_at ? '[deleted]' : comment.body}\n`);
      }
      return 0;
    }
    case 'comment': {
      const id = await resolve(a0);
      if (!id) return a0 ? 1 : missing('an artifact id');
      if (!a1?.trim()) return missing('comment text');
      const versions = await listArtifactVersions(pid, id);
      const version = versions[0]?.id;
      if (!version) return fail('The artifact has no saved Files version to anchor.');
      const text = f.quote === undefined ? '' : await (await readArtifactFile(pid, id, { version })).text();
      const anchor = artifactCommentAnchor(version, { quote: f.quote, selector: f.selector }, text);
      const thread = await createArtifactComment(pid, id, { anchor, body: a1 });
      return out(thread, status.ok(`Opened thread ${thread.thread_id}`));
    }
    case 'reply':
    case 'resolve':
    case 'reopen': {
      if (!a0) return missing('a thread id');
      if (sub === 'reply' && !a1?.trim()) return missing('reply text');
      const thread = await getArtifactCommentThread(pid, a0);
      if (sub === 'reply') {
        const comment = await replyArtifactComment(pid, thread.artifact_id, thread.thread_id, { body: a1! });
        return out(comment, status.ok(`Replied to ${thread.thread_id}`));
      }
      const changed = await setArtifactCommentStatus(pid, thread.artifact_id, thread.thread_id, sub === 'resolve' ? 'resolved' : 'open');
      return out(changed, status.ok(`${sub === 'resolve' ? 'Resolved' : 'Reopened'} ${thread.thread_id}`));
    }
    default: {
      const id = await resolve(a0);
      if (!id) return a0 ? 1 : missing('an artifact id');
      const page = await listArtifactActivity(pid, id, { ...(f.limit ? { limit: Number(f.limit) } : {}) });
      if (f.json) return out(page, '');
      for (const item of page.items) process.stdout.write(`${item.at}  ${pad(item.type, 20)}${item.actor.name ?? item.actor.id ?? 'System'}\n`);
      if (!page.items.length) process.stdout.write('No activity yet.\n');
      if (page.older_versions) process.stdout.write('Older saves may be unavailable in this history.\n');
      return 0;
    }
  }
}
