import type { Metadata } from 'next';
import { ApiReference } from './api-reference.client';

export const metadata: Metadata = {
  title: 'API reference',
  description: 'The full Kortix REST API, rendered from the live OpenAPI spec.',
};

export default function ApiReferencePage() {
  return <ApiReference />;
}
