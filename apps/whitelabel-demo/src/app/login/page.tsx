import { AuthForm } from '@/features/auth/auth-form';
import { loginAction } from '@/lib/actions';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  return <AuthForm mode="login" action={loginAction} error={params.error} />;
}
