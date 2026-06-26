import { AuthForm } from '@/features/auth/auth-form';
import { registerAction } from '@/lib/actions';

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  return <AuthForm mode="register" action={registerAction} error={params.error} />;
}
