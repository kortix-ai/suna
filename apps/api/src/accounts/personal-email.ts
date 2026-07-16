// Personal / free-consumer email detection (server copy).
//
// Splits signups into `business` (company domain — a real lead) vs `personal`
// (gmail, outlook, …) for the Mailtrap contact sync. Deliberately a denylist
// of well-known consumer + disposable providers, not an allowlist: any domain
// NOT listed is treated as a work domain. False negatives are fine.
//
// Keep in sync with apps/web/src/lib/personal-email.ts (the frontend uses the
// same list to gate the founder-concierge UI).

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
export function emailDomain(email?: string | null): string | null {
  const at = email?.trim().toLowerCase().lastIndexOf('@') ?? -1;
  if (!email || at < 0) return null;
  const domain = email
    .trim()
    .toLowerCase()
    .slice(at + 1);
  return domain || null;
}

/** True only for a parseable address on a non-consumer (work) domain. */
export function isWorkEmail(email?: string | null): boolean {
  const domain = emailDomain(email);
  return !!domain && !PERSONAL_EMAIL_DOMAINS.has(domain);
}

export function classifyEmailKind(email: string): 'business' | 'personal' {
  return isWorkEmail(email) ? 'business' : 'personal';
}
