import { redirect } from 'next/navigation';

// Set all dynamic options to prevent prerendering
// export const dynamic = 'force-dynamic';
// export const dynamicParams = true;
// export const revalidate = 0;
// export const fetchCache = 'force-no-store';
// export const runtime = 'edge';

export default function PersonalAccountPage() {
  redirect('/dashboard');
} 