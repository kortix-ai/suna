type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function artifactDiscussionStorage(
  viewerId: string | undefined,
  storage: () => LayoutStorage = () => window.localStorage,
): LayoutStorage {
  const key = (name: string) => `artifact-discussion:${viewerId}:${name}`;
  return {
    getItem(name) {
      if (!viewerId) return null;
      try {
        return storage().getItem(key(name));
      } catch {
        return null;
      }
    },
    setItem(name, value) {
      if (!viewerId) return;
      try {
        storage().setItem(key(name), value);
      } catch {
        return;
      }
    },
  };
}
