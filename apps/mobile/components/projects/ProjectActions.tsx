/**
 * ProjectActions — the ⋯ menu on a Projects tab row.
 *
 * A bottom sheet lists the actions: Open project, and Archive project for
 * managers. Archive is destructive, so it confirms in an AlertDialog. The
 * dialog opens after the sheet has finished closing, so two overlays never
 * stack. It stays open while the archive request runs and shows a failure in
 * place, the same pattern as Sign out.
 */

import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Archive, FolderOpen } from 'lucide-react-native';
import { chalkColors } from '@kortix/shared';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { Avatar } from '@/components/kortix/avatar';
import { Sheet, type SheetRef } from '@/components/kortix/sheet';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { useToast } from '@/components/kortix/toast-provider';
import { haptics } from '@/lib/haptics';
import { useArchiveProject } from '@/lib/projects/hooks';
import type { KortixProject } from '@/lib/projects/projects-client';

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

  // Set before closing the sheet; read when the close animation ends.
  const archiveAfterClose = React.useRef(false);
  const [confirmProject, setConfirmProject] = React.useState<KortixProject | null>(null);
  const [archiveFailed, setArchiveFailed] = React.useState(false);

  React.useEffect(() => {
    if (project) sheetRef.current?.open();
  }, [project]);

  const handleSheetDismiss = React.useCallback(() => {
    const current = project;
    const archiveNext = archiveAfterClose.current;
    archiveAfterClose.current = false;
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
    archiveAfterClose.current = true;
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

  const chalk = project ? chalkColors(project.name) : null;
  const canManage = !project?.effective_project_role || project.effective_project_role === 'manager';

  return (
    <>
      <Sheet ref={sheetRef} enablePanDownToClose onDismiss={handleSheetDismiss}>
        {project && chalk ? (
          <View
            className="px-5 pt-1"
            style={{ gap: 16, paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
            <View className="flex-row items-center gap-3 px-1">
              <Avatar
                variant="custom"
                fallbackText={project.name}
                size={40}
                backgroundColor={chalk.background}
                iconColor={chalk.foreground}
                borderColor={chalk.border}
              />
              <Text variant="large" className="flex-1" numberOfLines={1}>
                {project.name}
              </Text>
            </View>
            <SettingsGroup>
              <SettingsRow icon={FolderOpen} label="Open project" onPress={handleOpen} />
              {canManage ? (
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

      <AlertDialog
        open={!!confirmProject}
        onOpenChange={(open) => {
          // Keep the dialog up until an in-flight archive settles.
          if (!open && !archive.isPending) setConfirmProject(null);
        }}>
        <AlertDialogContent className="rounded-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Archive project</AlertDialogTitle>
            <AlertDialogDescription className={archiveFailed ? 'text-destructive' : undefined}>
              {archiveFailed
                ? 'Unable to archive. Check your connection and try again.'
                : `Archive “${confirmProject?.name ?? ''}”?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild disabled={archive.isPending}>
              <Button variant="secondary" size="lg" className="rounded-full">
                <Text>Cancel</Text>
              </Button>
            </AlertDialogCancel>
            <Button
              variant="destructive"
              size="lg"
              className="rounded-full"
              disabled={archive.isPending}
              onPress={confirmArchive}>
              <Text>{archive.isPending ? 'Archiving…' : 'Archive project'}</Text>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
