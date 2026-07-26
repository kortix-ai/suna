import { getEdgeMaintenanceConfig } from '@/lib/maintenance-store';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const config = await getEdgeMaintenanceConfig();
  return NextResponse.json(config, {
    headers: { 'Cache-Control': 'public, max-age=2, must-revalidate' },
  });
}
