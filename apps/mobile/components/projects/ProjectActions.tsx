/**
 * ProjectActions — the ⋯ menu on a Projects page row (`/projects`).
 *
 * A bottom sheet lists the actions: Open project, and Archive project for a
 * viewer who holds `project.write` and `project.delete` (KRTX-1720): Archive
 * calls `DELETE /projects/:id`, which loads the project for write and then
 * asserts `project.delete` (not implied by `project.write`). One `useCans`
 * probe answers; the row stays hidden until it does.
 * Archive is destructive, so it confirms in an AlertDialog. The
 * dialog opens after the sheet has finished closing, so two overlays never
 * stack. It stays open while the archive request runs and shows a failure in
 * place, the same pattern as Sign out.
 */

import * as React from 'react';
import { View } from 'react-native';
import { PROJECT_ACTIONS } from '@kortix/sdk';
import { useCans } from '@kortix/sdk/react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArchiveIcon as Archive, FolderOpenIcon as FolderOpen } from '@/lib/icons';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { Avatar } from '@/components/kortix/avatar';
import { Sheet, useCloseThen, type SheetRef } from '@/components/kortix/sheet';
import { PendingConfirmDialog } from '@/components/kortix/pending-confirm-dialog';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { useToast } from '@/components/kortix/toast-provider';
import { haptics } from '@/lib/haptics';
import { useArchiveProject } from '@/lib/projects/hooks';
import type { KortixProject } from '@/lib/projects/projects-client';

/** The leaves `DELETE /projects/:id` (Archive) asserts. */
const ARCHIVE_ACTIONS = [PROJECT_ACTIONS.PROJECT_WRITE, PROJECT_ACTIONS.PROJECT_DELETE] as const;

export function ProjectActions({
  project,
  onOpenProject,
  onClose,
}: {
  /** The row whose menu is open; null when closed. */
  project: KortixProject | null;
  onOpenProject: (project: KortixProject) => void;
  /** Called once the sheet has closed. The parent clears `project`. */
  onClose: () => void;
}) {
  const sheetRef = React.useRef<SheetRef>(null);
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const archive = useArchiveProject();

  // Set before closing the sheet; taken once when the close animation ends.
  const { deferAfterClose, takeAfterClose } = useCloseThen<boolean>();
  const [confirmProject, setConfirmProject] = React.useState<KortixProject | null>(null);
  const [archiveFailed, setArchiveFailed] = React.useState(false);

  React.useEffect(() => {
    if (project) sheetRef.current?.open();
  }, [project]);

  const handleSheetDismiss = React.useCallback(() => {
    const current = project;
    const archiveNext = takeAfterClose();
    onClose();
    if (current && archiveNext) {
      setArchiveFailed(false);
      setConfirmProject(current);
    }
  }, [onClose, project]);

  const handleOpen = React.useCallback(() => {
    if (!project) return;
    haptics.tap();
    // Navigate now; waiting for the sheet to close would delay the push.
    sheetRef.current?.close();
    onOpenProject(project);
  }, [onOpenProject, project]);

  const handleArchive = React.useCallback(() => {
    haptics.warning();
    deferAfterClose(true);
    sheetRef.current?.close();
  }, []);

  const confirmArchive = React.useCallback(async () => {
    if (!confirmProject) return;
    haptics.medium();
    setArchiveFailed(false);
    try {
      await archive.mutateAsync(confirmProject.project_id);
      haptics.success();
      toast.success('Project archived');
      setConfirmProject(null);
    } catch {
      haptics.warning();
      setArchiveFailed(true);
    }
  }, [archive, confirmProject, toast]);

  // `account_id` lets the probe run on the first render, without a project read.
  const cans = useCans({ projectId: project?.project_id, accountId: project?.account_id }, ARCHIVE_ACTIONS);
  const canArchive = ARCHIVE_ACTIONS.every((action) => cans[action]?.allowed === true);

  return (
    <>
      <Sheet ref={sheetRef} enablePanDownToClose onDismiss={handleSheetDismiss}>
        {project ? (
          <View
            className="px-5 pt-1"
            style={{ gap: 16, paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
            <View className="flex-row items-center gap-3 px-1">
              <Avatar chalk fallbackText={project.name} size={40} />
              <Text variant="large" className="flex-1" numberOfLines={1}>
                {project.name}
              </Text>
            </View>
            <SettingsGroup>
              <SettingsRow icon={FolderOpen} label="Open project" onPress={handleOpen} />
              {canArchive ? (
                <SettingsRow
                  icon={Archive}
                  label="Archive project"
                  destructive
                  right={null}
                  onPress={handleArchive}
                />
              ) : null}
            </SettingsGroup>
          </View>
        ) : null}
      </Sheet>

      <PendingConfirmDialog
        open={!!confirmProject}
        onOpenChange={(open) => {
          if (!open) setConfirmProject(null);
        }}
        pending={archive.isPending}
        title="Archive project"
        description={
          archiveFailed
            ? 'Unable to archive. Check your connection and try again.'
            : `Archive “${confirmProject?.name ?? ''}”?`
        }
        descriptionError={archiveFailed}
        confirmLabel={archive.isPending ? 'Archiving…' : 'Archive project'}
        confirmVariant="destructive"
        onConfirm={confirmArchive}
      />
</>
  );
}
