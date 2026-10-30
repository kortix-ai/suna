import { afterEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { SessionPermissionPrompt } from './session-permission-prompt';


const request = { id: 'permission-test', sessionID: 'session-test', permission: 'bash', patterns: ['echo test'], always: [], metadata: {} };

describe('permission decision buttons', () => {
  afterEach(() => mock.restore());

  test('forwards each reply and disables all choices while retaining the pending label', async () => {
    for (const [label, reply] of [['Deny', 'reject'], ['Allow for session', 'always'], ['Allow once', 'once']] as const) {
      let release = () => {};
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      const onReply = mock(() => waiting);
      let tree: ReturnType<typeof create> | undefined;
      await act(async () => {
        tree = create(
          <QueryClientProvider client={new QueryClient()}>
            <SessionPermissionPrompt sessionId="session-test" permissions={[request]} onReply={onReply} />
          </QueryClientProvider>,
        );
      });
      if (!tree) throw new Error('Renderer did not mount');
      const renderer = tree;
      const button = renderer.root.findAllByType('button').find((node) => node.findAllByType('span').some((span) => span.children.includes(label)));
      if (!button) throw new Error(`Missing ${label}`);
      await act(async () => { button.props.onClick(); });
      expect(onReply).toHaveBeenCalledWith('permission-test', reply);
      expect(renderer.root.findAllByType('button').every((node) => node.props.disabled)).toBe(true);
      expect(renderer.root.findAllByType('span').some((node) => node.props.className?.includes('invisible'))).toBe(true);
      await act(async () => { release(); await waiting; });
      expect(renderer.root.findAllByType('button').some((node) => node.props.disabled)).toBe(false);
      await act(async () => { renderer.unmount(); });
    }
  });
});
