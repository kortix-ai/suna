import { describe, expect, test } from 'bun:test';
import { checkWorkdirPermission, initPermissions } from '../../templates/base/harnesses/opencode/plugins/opencode-pty/src/plugin/pty/permissions';

describe('PTY external directory permissions', () => {
  for (const action of [undefined, 'allow', 'deny', 'ask'] as const) {
    test(`${action ?? 'absent'} outside-project permission`, async () => {
      const toasts: { message: string; variant: string }[] = [];
      initPermissions({
        config: { get: async () => ({ data: { permission: { external_directory: action } } }) },
        tui: { showToast: async ({ body }: { body: { message: string; variant: string } }) => { toasts.push(body); } },
      }, '/project');
      if (action === 'deny') {
        await expect(checkWorkdirPermission('/outside')).rejects.toThrow(
          'PTY spawn denied: Working directory "/outside" is outside project directory "/project". External directory access is denied by user configuration.',
        );
      } else if (action === 'ask') {
        await expect(checkWorkdirPermission('/outside')).rejects.toThrow(
          'PTY workdir denied: "/outside" requires user permission which is not supported by this plugin. Configure explicit "allow" or "deny" in your opencode.json permission.external_directory settings.',
        );
      } else {
        await expect(checkWorkdirPermission('/outside')).resolves.toBeUndefined();
      }
      expect(toasts).toHaveLength(action === 'ask' || action === 'deny' ? 1 : 0);
      if (action === 'ask' || action === 'deny') expect(toasts[0]?.variant).toBe('error');
      await expect(checkWorkdirPermission('/project/inside')).resolves.toBeUndefined();
    });
  }
});
