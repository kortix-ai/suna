'use client';

import { SystemFaultView } from '@/components/common/system-fault';

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>System fault</title>
      </head>
      <body style={{ margin: 0 }}>
        <SystemFaultView error={error} />
      </body>
    </html>
  );
}
