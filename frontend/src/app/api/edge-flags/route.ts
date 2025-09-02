import { maintenanceNoticeFlag } from '@/lib/edge-flags';

export const runtime = 'edge';

export async function GET() {
  const maintenanceNotice = await maintenanceNoticeFlag();

  return Response.json(maintenanceNotice);
}