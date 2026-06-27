import { createHmac, timingSafeEqual } from 'node:crypto';

const FIVE_MINUTES_S = 5 * 60;

export function verifyAgentMailSignature(input: {
  rawBody: string;
  secret: string;
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
}): boolean {
  const ts = Number(input.svixTimestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > FIVE_MINUTES_S) return false;

  const key = decodeSvixSecret(input.secret);
  if (!key) return false;
  const signed = `${input.svixId}.${input.svixTimestamp}.${input.rawBody}`;
  const expected = createHmac('sha256', key).update(signed).digest('base64');
  for (const part of input.svixSignature.split(/\s+/)) {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) continue;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

function decodeSvixSecret(secret: string): Buffer | null {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  try {
    return Buffer.from(raw, 'base64');
  } catch {
    return null;
  }
}
