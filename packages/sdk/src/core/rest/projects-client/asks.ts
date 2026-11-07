import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** What an ask waits on a person for. */
export type SessionAskKind = 'question' | 'permission' | 'approval';

/**
 * One open ask: an agent question, a tool call the permission policy sent to a
 * person, or a connector call that waits for approval. An ask never holds its
 * session: the agent goes on, and the decision reaches the session that asked
 * (`session_id`) as a new message.
 */
export interface SessionAsk {
  /** `<kind>:<id>`, the id `answerSessionAsk` takes. */
  id: string;
  kind: SessionAskKind;
  /** The session whose call asked: a hidden worker, or the session itself. */
  session_id: string;
  /** The session a person opens for this ask (a worker's root); "Needs you" shows there. */
  surface_session_id: string;
  /** The title of `surface_session_id`, when it has one. */
  session_title: string | null;
  /** The runtime's request id; for an approval, the execution id `resolveApproval` takes. */
  request_id: string;
  /** One line: the question, the command, the connector action. */
  title: string;
  asked_at: string;
  /** The ask closes as expired then. Null: never. */
  expires_at: string | null;
  question?: {
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description?: string }>;
      multiple?: boolean;
      custom?: boolean;
    }>;
  };
  permission?: { tool: string; permission: string; patterns: string[]; args: unknown };
  approval?: { action: string };
}

export interface SessionAsksResponse {
  asks: SessionAsk[];
  total: number;
}

/**
 * A decision on one ask: answers for a question (one list of labels or free
 * text per question), a dismissal, or a reply to a permission ask. A connector
 * approval is decided with `resolveApproval`.
 */
export type SessionAskAnswer =
  | { answers: string[][] }
  | { dismiss: true }
  | { reply: 'once' | 'always' | 'reject' };

export interface SessionAskAnswerResult {
  ok: boolean;
  /** `delivered`: the waiting call took it now. `queued`: the session hears it as a new message. `dismissed`. */
  delivery: string;
}

/** The open asks of a project the caller may decide, newest first. `surfaceSessionId` keeps those shown on that session. */
export async function listSessionAsks(
  projectId: string,
  options: { surfaceSessionId?: string; limit?: number } = {},
): Promise<SessionAsksResponse> {
  const query = new URLSearchParams();
  if (options.surfaceSessionId) query.set('surface_session_id', options.surfaceSessionId);
  if (options.limit) query.set('limit', String(options.limit));
  const suffix = query.size ? `?${query.toString()}` : '';
  return unwrap(await backendApi.get<SessionAsksResponse>(`/workspaces/${projectId}/asks${suffix}`));
}

/** Answer a question or decide a permission ask. Throws on a refusal, including an ask already decided (409). */
export async function answerSessionAsk(
  projectId: string,
  askId: string,
  answer: SessionAskAnswer,
): Promise<SessionAskAnswerResult> {
  return unwrap(
    await backendApi.post<SessionAskAnswerResult>(`/workspaces/${projectId}/asks/${encodeURIComponent(askId)}/answer`, answer),
  );
}
