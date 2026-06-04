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
