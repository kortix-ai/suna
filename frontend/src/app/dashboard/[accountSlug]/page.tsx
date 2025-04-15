import { redirect } from 'next/navigation';

interface AccountRedirectProps {
  params: {
    accountSlug: string;
  };
}

export default function AccountRedirect({
  params,
}: AccountRedirectProps) {
  const { accountSlug } = params;
  
  // Redirect to the settings page
  redirect(`/dashboard/${accountSlug}/settings`);
} 