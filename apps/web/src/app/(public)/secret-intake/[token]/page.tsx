'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { SecretIntakeForm } from '@/components/setup-links/secret-intake-form';

export default function SecretIntakePage() {
  const params = useParams();
  const token = Array.isArray(params.token) ? params.token[0] : (params.token as string);

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <KortixLogo />
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add a project secret</CardTitle>
            <CardDescription>
              Your Kortix agent needs this to continue. Enter the value below — it’s encrypted
              and the agent never sees it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SecretIntakeForm token={token} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
