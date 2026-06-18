'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ConnectorIntake } from '@/components/setup-links/connector-intake';

export default function ConnectIntakePage() {
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
            <CardTitle className="text-base">Connect an app</CardTitle>
            <CardDescription>
              Your Kortix agent wants to connect this app on your behalf. Authorize it in one
              click — no keys are pasted into chat or stored in the repo.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ConnectorIntake token={token} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
