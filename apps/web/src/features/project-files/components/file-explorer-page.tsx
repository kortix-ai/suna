'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useProjectContext } from '../context';
import { useChangeRequests } from '../hooks/use-change-requests';
import { ChangeRequestDetailDialog } from './change-request-detail-dialog';
import { ChangeRequestsPanel } from './change-requests-panel';
import { CheckpointsPanel } from './checkpoints-panel';
import { DriveExplorer } from './drive-explorer';
import { OpenChangeRequestDialog } from './open-change-request-dialog';

type RightPanel = 'checkpoints' | 'change-requests' | null;

/**
 * Project git-ref file explorer page (customize → Files). Thin wrapper over
 * the shared <DriveExplorer> that adds the git-only chrome: version selector,
 * checkpoints panel, change-request panel + dialogs. Requires both a
 * <ProjectFilesProvider> and a git-ref <FileExplorerSourceProvider>.
 */
export function FileExplorerPage() {
  const projectCtx = useProjectContext();
  const projectId = projectCtx?.projectId ?? '';

  const [rightPanel, setRightPanel] = useState<RightPanel>(null);
  const [openCrDialogShown, setOpenCrDialogShown] = useState(false);
  const [createdCrId, setCreatedCrId] = useState<string | null>(null);
  const activeRefForCrs = projectCtx?.ref ?? '';
  const defaultBranchForCrs = projectCtx?.defaultBranch ?? '';
  const canOpenChangeRequest = Boolean(
    activeRefForCrs && defaultBranchForCrs && activeRefForCrs !== defaultBranchForCrs,
  );
  const toggleRightPanel = (panel: RightPanel) =>
    setRightPanel((current) => (current === panel ? null : panel));

  const openCrCountQuery = useChangeRequests('open', { refetchInterval: 10_000 });
  const openCrCount = openCrCountQuery.data?.change_requests.length ?? 0;

  // Deep link: /…?cr=<id> opens the change-request detail dialog once.
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    const cr = searchParams.get('cr');
    if (!cr) return;
    setCreatedCrId(cr);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('cr');
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [searchParams, pathname, router]);

  return (
    <DriveExplorer
      toolbar={{
        showVersionSelector: true,
        checkpointsToggle: {
          open: rightPanel === 'checkpoints',
          onToggle: () => toggleRightPanel('checkpoints'),
        },
        changeRequestsToggle: {
          open: rightPanel === 'change-requests',
          onToggle: () => toggleRightPanel('change-requests'),
          openCount: openCrCount,
        },
        openChangeRequestAction: {
          onClick: () => setOpenCrDialogShown(true),
        },
      }}
      panels={
        <>
          <CheckpointsPanel
            open={rightPanel === 'checkpoints'}
            onClose={() => setRightPanel(null)}
          />
          <ChangeRequestsPanel
            open={rightPanel === 'change-requests'}
            onClose={() => setRightPanel(null)}
          />
        </>
      }
    >
      <OpenChangeRequestDialog
        open={openCrDialogShown}
        onOpenChange={setOpenCrDialogShown}
        projectId={projectId}
        defaultBranch={defaultBranchForCrs}
        initialHeadRef={canOpenChangeRequest ? activeRefForCrs : undefined}
        onCreated={(crId) => {
          setRightPanel('change-requests');
          setCreatedCrId(crId);
        }}
      />

      <ChangeRequestDetailDialog crId={createdCrId} onClose={() => setCreatedCrId(null)} />
    </DriveExplorer>
  );
}
