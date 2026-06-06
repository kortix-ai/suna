// Personal / free-consumer email detection.
//
// We use this to tell apart a work email (someone signing up with their
// company domain — a real lead) from a personal/free inbox (gmail, outlook,
// icloud, …). Enterprise-demo surfaces only show to work-email signups.
//
// This is intentionally a denylist of well-known consumer + disposable
// providers, not an allowlist: any domain NOT on this list is treated as a
// work domain. False negatives (a consumer provider we forgot) are fine; the
// list just needs to catch the common ones.

const PERSONAL_EMAIL_DOMAINS = new Set<string>([
  // Google
  'gmail.com',
  'googlemail.com',
  // Microsoft
  'outlook.com',
  'outlook.co.uk',
  'hotmail.com',
  'hotmail.co.uk',
  'hotmail.fr',
  'live.com',
  'live.co.uk',
  'msn.com',
  // Yahoo / AOL
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.co.in',
  'yahoo.fr',
  'yahoo.de',
  'ymail.com',
  'rocketmail.com',
  'aol.com',
  // Apple
  'icloud.com',
  'me.com',
  'mac.com',
  // Proton
  'proton.me',
  'protonmail.com',
  'pm.me',
  // Other consumer providers
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'hey.com',
  'fastmail.com',
  'tutanota.com',
  'tutamail.com',
  'hushmail.com',
  'web.de',
  't-online.de',
  'free.fr',
  'orange.fr',
  'libero.it',
  'qq.com',
  '163.com',
  '126.com',
  'naver.com',
  'hanmail.net',
  'daum.net',
  // Disposable / throwaway
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'yopmail.com',
  'trashmail.com',
]);

/** Domain portion of an email, lowercased — or `null` if unparseable. */
function emailDomain(email?: string | null): string | null {
  const at = email?.trim().toLowerCase().lastIndexOf('@') ?? -1;
  if (!email || at < 0) return null;
  const domain = email.trim().toLowerCase().slice(at + 1);
  return domain || null;
}

/** True when the address is a known personal/free/disposable provider. */
export function isPersonalEmail(email?: string | null): boolean {
  const domain = emailDomain(email);
  return domain ? PERSONAL_EMAIL_DOMAINS.has(domain) : false;
}

/** True only for a parseable address on a non-consumer (work) domain. */
export function isWorkEmail(email?: string | null): boolean {
  const domain = emailDomain(email);
  return !!domain && !PERSONAL_EMAIL_DOMAINS.has(domain);
}
