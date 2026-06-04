export { FilesystemScopeEditor } from './filesystem-scope-editor';
export { ShellScopeEditor } from './shell-scope-editor';
export { NetworkScopeEditor } from './network-scope-editor';

import type { PermissionScope } from '../types';

export function getScopeEditorCapability(capability: string): 'filesystem' | 'shell' | 'network' | null {
  switch (capability) {
    case 'filesystem':
      return 'filesystem';
    case 'shell':
      return 'shell';
    case 'network':
      return 'network';
    default:
      return null;
  }
}

export function summarizeScope(capability: string, scope: PermissionScope): string {
  if (!scope || Object.keys(scope).length === 0) return 'Unrestricted access';

  switch (capability) {
    case 'filesystem': {
      const fs = scope as { paths?: string[]; operations?: string[] };
      const parts: string[] = [];
      if (fs.operations?.length) parts.push(fs.operations.join(', '));
      if (fs.paths?.length) parts.push(fs.paths.length === 1 ? fs.paths[0] : `${fs.paths.length} paths`);
      return parts.length ? parts.join(' on ') : 'Unrestricted access';
    }
    case 'shell': {
      const sh = scope as { commands?: string[]; workingDir?: string };
      const parts: string[] = [];
      if (sh.commands?.length) parts.push(sh.commands.join(', '));
      if (sh.workingDir) parts.push(`in ${sh.workingDir}`);
      return parts.length ? parts.join(' ') : 'Unrestricted access';
    }
    case 'network': {
      const net = scope as { ports?: number[]; hosts?: string[]; protocols?: string[] };
      const parts: string[] = [];
      if (net.protocols?.length) parts.push(net.protocols.join('/').toUpperCase());
      if (net.hosts?.length) parts.push(net.hosts.length === 1 ? net.hosts[0] : `${net.hosts.length} hosts`);
      if (net.ports?.length) parts.push(`port ${net.ports.join(', ')}`);
      return parts.length ? parts.join(' on ') : 'Unrestricted access';
    }
    default:
      return 'Unrestricted access';
  }
}
