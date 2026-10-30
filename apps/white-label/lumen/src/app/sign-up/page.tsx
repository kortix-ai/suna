'use client';

import { AuthScreen } from '@/components/auth-screen';

export default function SignUpPage() {
  return (
    <AuthScreen
      initialMode="sign-up"
      subtitle="Start a free trial for your firm. No card needed."
      redirectTo={{ 'sign-in': '/app', 'sign-up': '/onboarding' }}
    />
  );
}
