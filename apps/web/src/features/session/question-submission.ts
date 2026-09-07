export function createQuestionSubmission(
  setBusy: (busy: boolean) => void,
  onError: (error: unknown) => void,
): (submit: () => void | Promise<void>) => Promise<boolean> {
  let pending = false;
  return async (submit) => {
    if (pending) return false;
    pending = true;
    setBusy(true);
    try {
      await submit();
      return true;
    } catch (error) {
      onError(error);
      return false;
    } finally {
      pending = false;
      setBusy(false);
    }
  };
}
