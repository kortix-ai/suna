export function createPermissionModeSubmission(
  setBusy: (enabled: boolean | null) => void,
  onError: (error: unknown) => void,
) {
  let pending = false;
  return async (
    enabled: boolean,
    update: () => Promise<void>,
    confirm: () => void,
  ): Promise<boolean> => {
    if (pending) return false;
    pending = true;
    setBusy(enabled);
    try {
      await update();
      confirm();
      return true;
    } catch (error) {
      onError(error);
      return false;
    } finally {
      pending = false;
      setBusy(null);
    }
  };
}
