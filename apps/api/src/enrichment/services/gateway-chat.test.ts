import { describe, expect, test } from 'bun:test';
import type { CreateAccountTokenParams, CreateAccountTokenResult } from '../../repositories/account-tokens';
import { withGatewayChat, type GatewayChatDeps, type JobPrincipal } from './gateway-chat';

const PRINCIPAL: JobPrincipal = {
  accountId: 'acc-1',
  userId: 'user-1',
  projectId: 'proj-1',
};

function token(overrides: Partial<CreateAccountTokenResult> = {}): CreateAccountTokenResult {
  return {
    tokenId: 'tok-1',
    publicKey: 'pk',
    secretKey: 'sk-secret',
    name: 'Domain enrichment',
    status: 'active',
    projectId: 'proj-1',
    expiresAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function harness(respond: () => Response) {
  const minted: CreateAccountTokenParams[] = [];
  const revoked: Array<{ tokenId: string; accountId: string; projectId?: string | null }> = [];
  const requests: Array<{ authorization: string | undefined; body: Record<string, unknown> }> = [];

  const deps: GatewayChatDeps = {
    mintToken: async (params) => {
      minted.push(params);
      return token();
    },
    revokeToken: async (tokenId, accountId, projectId) => {
      revoked.push({ tokenId, accountId, projectId });
      return true;
    },
    chatCompletions: async ({ authorization, rawBody }) => {
      requests.push({ authorization, body: JSON.parse(rawBody) });
      return respond();
    },
  };

  return { deps, minted, revoked, requests };
}

const CHAT_ARGS = {
  messages: [{ role: 'user' as const, content: 'hi' }],
  model: 'glm-5.2',
  jsonSchema: { type: 'object' },
};

describe('withGatewayChat', () => {
  test('returns the assistant content', async () => {
    const h = harness(() => completion('{"ok":true}'));
    const result = await withGatewayChat(PRINCIPAL, (chat) => chat(CHAT_ARGS), h.deps);
    expect(result).toBe('{"ok":true}');
  });

  test('mints a project-scoped token that expires', async () => {
    const h = harness(() => completion('x'));
    await withGatewayChat(PRINCIPAL, (chat) => chat(CHAT_ARGS), h.deps);

    expect(h.minted).toHaveLength(1);
    expect(h.minted[0]).toMatchObject({
      accountId: 'acc-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });
    expect(h.minted[0].expiresAt).toBeInstanceOf(Date);
  });

  test('authorizes the completion with the minted secret', async () => {
    const h = harness(() => completion('x'));
    await withGatewayChat(PRINCIPAL, (chat) => chat(CHAT_ARGS), h.deps);
    expect(h.requests[0].authorization).toBe('Bearer sk-secret');
  });

  test('sends a non-streaming request carrying the schema and model', async () => {
    const h = harness(() => completion('x'));
    await withGatewayChat(PRINCIPAL, (chat) => chat(CHAT_ARGS), h.deps);

    const body = h.requests[0].body;
    expect(body.model).toBe('glm-5.2');
    expect(body.stream).toBe(false);
    expect(body.response_format).toMatchObject({ type: 'json_schema' });
  });

  test('revokes the token after a successful call', async () => {
    const h = harness(() => completion('x'));
    await withGatewayChat(PRINCIPAL, (chat) => chat(CHAT_ARGS), h.deps);
    expect(h.revoked).toEqual([{ tokenId: 'tok-1', accountId: 'acc-1', projectId: 'proj-1' }]);
  });

  test('revokes the token when the body throws', async () => {
    const h = harness(() => completion('x'));
    await expect(
      withGatewayChat(
        PRINCIPAL,
        async () => {
          throw new Error('extraction blew up');
        },
        h.deps,
      ),
    ).rejects.toThrow('extraction blew up');
    expect(h.revoked).toHaveLength(1);
  });

  test('does not fail the job when revocation fails', async () => {
    const h = harness(() => completion('x'));
    const deps: GatewayChatDeps = {
      ...h.deps,
      revokeToken: async () => {
        throw new Error('db down');
      },
    };
    const result = await withGatewayChat(PRINCIPAL, (chat) => chat(CHAT_ARGS), deps);
    expect(result).toBe('x');
  });

  test('surfaces a non-2xx gateway response as an error', async () => {
    const h = harness(() => new Response('rate limited', { status: 429 }));
    await expect(withGatewayChat(PRINCIPAL, (chat) => chat(CHAT_ARGS), h.deps)).rejects.toThrow(
      /429/,
    );
  });

  test('rejects a response with no assistant content', async () => {
    const h = harness(
      () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    await expect(withGatewayChat(PRINCIPAL, (chat) => chat(CHAT_ARGS), h.deps)).rejects.toThrow(
      /no assistant content/,
    );
  });

  test('joins content returned as typed parts', async () => {
    const h = harness(
      () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: [{ text: '{"a":' }, { text: '1}' }] } }] }),
          { status: 200 },
        ),
    );
    const result = await withGatewayChat(PRINCIPAL, (chat) => chat(CHAT_ARGS), h.deps);
    expect(result).toBe('{"a":1}');
  });
});
