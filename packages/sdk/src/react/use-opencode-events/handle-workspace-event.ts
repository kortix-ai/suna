import { useSyncStore } from '../../browser/stores/sync-store';
import { infoToast } from '../../platform/ui';
import { binaryBlobKeys, fileContentKeys, fileListKeys, gitStatusKeys } from '../file-keys';
import { ptyKeys } from '../use-opencode-pty';
import { runtimeKeys } from '../use-opencode-sessions';
import type { HandlerContext } from './handler-context';
import { scheduleProjectMetadataRefetch } from './helpers';
import type { RuntimeEvent } from './types';
export function handleWorkspaceEvent(event: RuntimeEvent, ctx: HandlerContext) {
  const { queryClient, markSessionAbortedLocally, fetchLspDiagnosticsDebounced } = ctx;
  switch (event.type) {
    case 'session.diff': {
      const props = event.properties;
      if (props.sessionID) {
        queryClient.setQueryData(['opencode', 'session-diff', props.sessionID], props.diff);
      }
      queryClient.invalidateQueries({ queryKey: runtimeKeys.vcsDiffAll(), type: 'active' });
      break;
    }
    case 'todo.updated': {
      const props = event.properties;
      if (props.sessionID) {
        queryClient.setQueryData(['opencode', 'session-todo', props.sessionID], props.todos);
      }
      break;
    }
    case 'vcs.branch.updated': {
      const props = event.properties;
      queryClient.setQueryData(['opencode', 'vcs'], { branch: props.branch });
      queryClient.invalidateQueries({ queryKey: runtimeKeys.vcsDiffAll(), type: 'active' });
      break;
    }
    case 'server.instance.disposed': {
      for (const [sessionID, status] of Object.entries(useSyncStore.getState().sessionStatus)) {
        if (status?.type !== 'idle') {
          markSessionAbortedLocally.current(
            sessionID,
            'The operation was aborted because the server instance was disposed.',
          );
        }
      }
      queryClient.invalidateQueries({ queryKey: runtimeKeys.sessions(), type: 'active' });
      queryClient.invalidateQueries({ queryKey: runtimeKeys.mcpStatus(), type: 'active' });
      queryClient.invalidateQueries({ queryKey: runtimeKeys.skills(), type: 'active' });
      queryClient.invalidateQueries({ queryKey: runtimeKeys.agents(), type: 'active' });
      queryClient.invalidateQueries({ queryKey: runtimeKeys.toolIds(), type: 'active' });
      queryClient.invalidateQueries({ queryKey: runtimeKeys.commands(), type: 'active' });
      break;
    }
    case 'lsp.updated': {
      queryClient.invalidateQueries({
        queryKey: ['opencode', 'lsp'],
        type: 'active',
      });
      fetchLspDiagnosticsDebounced.current();
      break;
    }
    case 'lsp.client.diagnostics': {
      fetchLspDiagnosticsDebounced.current();
      break;
    }
    case 'mcp.tools.changed': {
      queryClient.refetchQueries({ queryKey: runtimeKeys.mcpStatus(), type: 'active' });
      queryClient.refetchQueries({ queryKey: runtimeKeys.toolIds(), type: 'active' });
      break;
    }
    case 'pty.created':
    case 'pty.updated':
    case 'pty.exited':
    case 'pty.deleted': {
      queryClient.invalidateQueries({ queryKey: ptyKeys.listPrefix(), type: 'active' });
      break;
    }
    case 'worktree.ready': {
      queryClient.invalidateQueries({ queryKey: runtimeKeys.worktrees(), type: 'active' });
      queryClient.invalidateQueries({ queryKey: runtimeKeys.projects(), type: 'active' });
      break;
    }
    case 'worktree.failed': {
      queryClient.invalidateQueries({ queryKey: runtimeKeys.worktrees(), type: 'active' });
      break;
    }
    case 'project.updated': {
      scheduleProjectMetadataRefetch(queryClient);
      break;
    }
    case 'file.edited': {
      const fileProps = event.properties;
      queryClient.invalidateQueries({ queryKey: fileListKeys.all, type: 'active' });
      queryClient.invalidateQueries({ queryKey: gitStatusKeys.all, type: 'active' });
      queryClient.invalidateQueries({ queryKey: runtimeKeys.vcsDiffAll(), type: 'active' });
      if (fileProps.file) {
        queryClient.invalidateQueries({ queryKey: fileContentKeys.all, type: 'active' });
        queryClient.invalidateQueries({ queryKey: binaryBlobKeys.all, type: 'active' });
      }
      break;
    }
    case 'installation.updated': {
      const installProps = event.properties;
      const versionStr = installProps.version ? ` (v${installProps.version})` : '';
      infoToast(`Installation updated${versionStr}. Restart to apply changes.`, {
        duration: 10_000,
      });
      break;
    }
    case 'installation.update-available': {
      const updateProps = event.properties;
      const versionLabel = updateProps.version ? `v${updateProps.version}` : 'A new version';
      infoToast(`${versionLabel} is available. Update when you're ready.`, {
        duration: 15_000,
      });
      break;
    }
    default:
      break;
  }
}
