import { emailDomain, isWorkEmail } from './personal-email';

/** Classification policy matches the existing consumer-domain gate. */
export function enrichSalesEvent(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.type !== 'account.signup' || !payload.data || typeof payload.data !== 'object') return payload;
  const data = payload.data;
  if (!('email' in data) || typeof data.email !== 'string') return payload;
  const domain = emailDomain(data.email);
  const disposable = ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'yopmail.com', 'trashmail.com'].includes(domain ?? '');
  return { ...payload, data: { ...data, email_kind: disposable ? 'disposable' : isWorkEmail(data.email) ? 'work' : 'freemail' } };
}
