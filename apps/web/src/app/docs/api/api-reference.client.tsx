'use client';

import dynamic from 'next/dynamic';

const ApiReferenceReact = dynamic(
  () =>
    import('@scalar/api-reference-react').then((mod) => mod.ApiReferenceReact),
  { ssr: false },
);

const SPEC_URL = '/docs/api/openapi.json';

export function ApiReference() {
  return (
    <div className="min-h-screen w-full">
      <ApiReferenceReact
        configuration={{
          url: SPEC_URL,
          hideClientButton: true,
        }}
      />
    </div>
  );
}
