// This file configures Next.js options for the entire dashboard route group
// https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config

// Disable static rendering completely for all dashboard routes
export const dynamic = 'force-dynamic';

// Disable static generation for all routes under dashboard
export const generateStaticParams = () => {
  return [];
};

// Disable optimization attempts
export const preferredRegion = 'auto';
export const revalidate = 0;

// Dynamically generate dynamic params
export const dynamicParams = true;