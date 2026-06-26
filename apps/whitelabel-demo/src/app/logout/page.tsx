import { redirect } from 'next/navigation';
import { clearBrowserSession } from '../../lib/auth';

export default async function LogoutPage() {
  await clearBrowserSession();
  redirect('/login');
}
