'use client';

import { redirect } from 'next/navigation';
import React from 'react';

type AccountParams = {
  accountSlug: string;
};

export default function AccountRedirect({
  params,
}: {
  params: Promise<AccountParams>;
}) {
  const unwrappedParams = React.use(params);
  const { accountSlug } = unwrappedParams;

  // Redirect to the settings page
  redirect(`/${accountSlug}/settings`);
}
