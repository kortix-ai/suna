/**
 * The inbound webhook signing scheme, in one place: the header, the algorithm,
 * and the copy-pasteable sample request both the dashboard's trigger sheet and
 * `kortix triggers info` render. The wire behavior itself is
 * `verifyWebhookSignature` in `apps/api/src/projects/lib/triggers.ts`.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'X-Kortix-Signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'X-Kortix-Timestamp';
/** The API requires the timestamp: it signs `<timestamp>.<body>` and refuses a missing or stale one (KRTX-4098). */
export const WEBHOOK_SIGNATURE_ALGORITHM =
  'HMAC-SHA256 over `<X-Kortix-Timestamp>.<exact raw request body>`';
/** Names one event: a sender's retry with the same id runs once. The API also
 *  reads the ids GitHub, GitLab, Linear and Standard Webhooks senders set
 *  (`apps/api/src/projects/lib/webhook-delivery.ts`). */
export const WEBHOOK_DELIVERY_ID_HEADER = 'X-Kortix-Delivery-Id';

/** A copy-pasteable request for whoever is wiring the other end up. */
export function buildWebhookSampleRequest(url: string): string {
  // One `date +%s` feeds both the header and the signature, so the pair can
  // never straddle a second boundary and fail verification.
  return [
    'TS=$(date +%s)',
    `curl -X POST ${url} \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "${WEBHOOK_DELIVERY_ID_HEADER}: $(uuidgen)" \\`,
    `  -H "${WEBHOOK_TIMESTAMP_HEADER}: $TS" \\`,
    `  -H "${WEBHOOK_SIGNATURE_HEADER}: sha256=$(printf '%s.%s' "$TS" '$BODY' | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')" \\`,
    `  -d '$BODY'`,
    '',
    `# $BODY   is the JSON you want to send, e.g. {"event":"deploy.succeeded"}`,
    '# $SECRET is the signing key you saved for this webhook',
    `# ${WEBHOOK_DELIVERY_ID_HEADER} names this event: a retry with the same id runs once.`,
    '# The signature covers the timestamp: a delivery older than 5 minutes is refused, so a captured one cannot replay.',
    '# Without it, an identical body within 10 minutes counts as the same event.',
  ].join('\n');
}
