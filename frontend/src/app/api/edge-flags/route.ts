import { maintenanceNoticeFlag } from '@/lib/edge-flags';

export const runtime = 'edge';

export async function GET() {
  try {
    const maintenanceNotice = await maintenanceNoticeFlag();
    return Response.json(maintenanceNotice);
  } catch (error) {
    console.error('[API] Error in edge flags route:', error);
    return Response.json({ enabled: false }, { status: 500 });
  }
}