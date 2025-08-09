import { maintenanceNoticeFlag } from '@/lib/edge-flags';
import { NextResponse } from 'next/server';

export async function GET() {
  const maintenanceNotice = await maintenanceNoticeFlag();
  return NextResponse.json(maintenanceNotice);
}
