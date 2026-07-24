/**
 * Binds extraction to the real LLM gateway.
 *
 * The gateway authenticates by token, not by ambient context — that is what
 * makes usage attributable. A background job has no request to borrow a token
 * from, so it mints a short-lived project-scoped one for the account that
 * asked for the enrichment, uses it for exactly one completion, and revokes it
 * in a finally block. Spend then lands on the requesting account's ledger
 * through the same path an API call would take, and nothing long-lived is left
 * behind if the worker dies mid-job.
 *
 * The token is project-scoped deliberately: project-scoped tokens skip the
 * personal-access-token policy checks that exist for user-held credentials,
 * and scoping also means a leaked value could only ever act on the one project
 * the job was already running for.
 */
import { getInProcessGateway } from '../../llm-gateway/wire';
import {
  createAccountToken,
  revokeAccountToken,
  type CreateAccountTokenParams,
  type CreateAccountTokenResult,
} from '../../repositories/account-tokens';
import type { ChatFn } from './extract';

const TOKEN_TTL_MS = 15 * 60 * 1000;

export interface JobPrincipal {
  accountId: string;
  userId: string;
  projectId: string;
}

export interface GatewayChatDeps {
  mintToken?: (params: CreateAccountTokenParams) => Promise<CreateAccountTokenResult>;
  revokeToken?: (tokenId: string, accountId: string, projectId?: string | null) => Promise<boolean>;
  chatCompletions?: (req: {
    authorization: string | undefined;
    rawBody: string;
    signal?: AbortSignal;
  }) => Promise<Response>;
}

function readContent(payload: unknown): string {
  const choice = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  // Some providers return content as an array of typed parts.
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === 'string' ? part : (part as { text?: string })?.text ?? ''))
      .join('');
    if (joined.trim()) return joined;
  }
  throw new Error('gateway returned no assistant content');
}

/**
 * Build a {@link ChatFn} bound to a freshly minted token, run `fn` with it,
 * then revoke. The token never outlives the call.
 */
export async function withGatewayChat<T>(
  principal: JobPrincipal,
  fn: (chat: ChatFn) => Promise<T>,
  deps: GatewayChatDeps = {},
): Promise<T> {
  const mint = deps.mintToken ?? createAccountToken;
  const revoke = deps.revokeToken ?? revokeAccountToken;
  const chatCompletions =
    deps.chatCompletions ?? ((req) => getInProcessGateway().chatCompletions(req));

  const token = await mint({
    accountId: principal.accountId,
    userId: principal.userId,
    projectId: principal.projectId,
    name: 'Domain enrichment',
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });

  const chat: ChatFn = async ({ messages, model, jsonSchema, signal }) => {
    const res = await chatCompletions({
      authorization: `Bearer ${token.secretKey}`,
      rawBody: JSON.stringify({
        model,
        messages,
        stream: false,
        // Forwarded verbatim to openai-compatible upstreams. Providers that
        // ignore it still work: the response is validated by Zod either way,
        // and the repair loop covers the difference.
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'company_profile', schema: jsonSchema },
        },
      }),
      signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`gateway completion failed (${res.status}): ${detail.slice(0, 500)}`);
    }
    return readContent(await res.json());
  };

  try {
    return await fn(chat);
  } finally {
    await revoke(token.tokenId, principal.accountId, principal.projectId).catch(() => {
      // A stranded token expires on its own; never fail a finished job over it.
    });
  }
}
