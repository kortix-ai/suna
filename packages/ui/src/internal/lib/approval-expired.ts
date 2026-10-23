/** True when the API reports the approval expired before this decision (HTTP 409). */
export function isApprovalExpiredError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'APPROVAL_EXPIRED';
}
