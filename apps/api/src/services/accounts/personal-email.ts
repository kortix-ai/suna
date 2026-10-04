export { emailDomain, isWorkEmail } from '@kortix/shared/personal-email';
import { isWorkEmail } from '@kortix/shared/personal-email';

export function classifyEmailKind(email: string): 'business' | 'personal' {
  return isWorkEmail(email) ? 'business' : 'personal';
}
