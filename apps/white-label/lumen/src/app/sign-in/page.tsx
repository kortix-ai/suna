'use client';

import { AuthScreen } from '@/components/auth-screen';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

/** Only same-site paths: an open redirect to another origin is refused. */
const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') ? next : '/app');

function SignIn() {
  const next = safeNext(useSearchParams().get('next'));
  return <AuthScreen initialMode="sign-in" redirectTo={{ 'sign-in': next, 'sign-up': '/onboarding' }} />;
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignIn />
    </Suspense>
  );
}
