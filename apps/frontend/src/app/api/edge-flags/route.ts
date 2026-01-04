import { maintenanceNoticeFlag, technicalIssueFlag } from '@/lib/edge-flags';

export const runtime = 'edge';

export async function GET() {
  try {
    const [maintenanceNotice, technicalIssue] = await Promise.all([
      maintenanceNoticeFlag(),
      technicalIssueFlag(),
    ]);
    
    return Response.json({
      maintenanceNotice,
      technicalIssue,
    });
  } catch (error) {
    console.error('[API] Error in edge flags route:', error);
    return Response.json({ 
      maintenanceNotice: { enabled: false },
      technicalIssue: { enabled: false }
    }, { status: 500 });
  }
}
