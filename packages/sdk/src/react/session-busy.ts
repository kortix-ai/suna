export interface SessionBusyInput {
  syncBusy: boolean;
  hasPendingText: boolean;
  usesAcp: boolean;
  acpSending: boolean;
}

export function resolveSessionBusy(input: SessionBusyInput): boolean {
  return input.syncBusy || input.hasPendingText || (input.usesAcp && input.acpSending);
}
