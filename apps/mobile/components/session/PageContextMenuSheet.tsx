/**
 * PageContextMenuSheet — the `···` page-context menus that used to live in
 * `BottomBar`'s `customMenuItems` prop. Two pages had one: `page:workspace`
 * (New agent / skill / command / project, MCP, settings, refresh) and
 * `page:files` (contextual file actions when a file is selected, otherwise
 * general file/view actions).
 *
 * `FilesPageRef` and `WorkspacePageRef` already expose their relevant state
 * as readable fields, so — unlike the legacy screen, which mirrored
 * `filesViewMode` / `filesShowHidden` / `filesSelectedName` up into itself
 * just to label this menu — this sheet reads that state directly off the
 * page ref. It snapshots it once in `open()` so the Files arm never goes
 * stale while the sheet is visible (every action closes the sheet).
 */
import * as React from 'react';
import { View } from 'react-native';
import {
  Copy,
  Eye,
  EyeOff,
  FileText,
  FilePlus,
  FolderPlus,
  Image as ImageIcon,
  LayoutGrid,
  List,
  Plug,
  RefreshCw,
  Upload,
} from 'lucide-react-native';

import type { SandboxFile } from '@/api/types';
import type { FilesPageRef } from '@/components/pages/FilesPage';
import type { WorkspacePageRef } from '@/components/pages/WorkspacePage';
import { Icon } from '@/components/ui/icon';
import { ListRow } from '@/components/ui/list-row';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetBody, SheetHeader, type SheetRef } from '@/components/ui/sheet';
import { DOCK_ICONS } from './dock-icons';

export type PageContextMenuTarget = { page: 'workspace' } | { page: 'files' };

export interface PageContextMenuSheetProps {
  target: PageContextMenuTarget | null;
  workspaceRef: React.RefObject<WorkspacePageRef | null>;
  filesRef: React.RefObject<FilesPageRef | null>;
  /** Starts an agent-led session, e.g. "New agent". */
  onCreateSessionWithPrompt: (title: string, prompt: string) => void;
}

const WORKSPACE_PROMPTS = [
  {
    icon: DOCK_ICONS.agents,
    label: 'New agent',
    title: 'New agent',
    prompt:
      "HEY let's build a new agent. Ask what job it should own, then scaffold it in the right workspace location and wire up any supporting skills.",
  },
  {
    icon: DOCK_ICONS.skills,
    label: 'New skill',
    title: 'New skill',
    prompt:
      "HEY let's build a new skill. Ask what should trigger it, then create the SKILL.md and any supporting files in the right workspace location.",
  },
  {
    icon: DOCK_ICONS.terminal,
    label: 'New command',
    title: 'New command',
    prompt:
      "HEY let's build a new slash command. Ask what the command should do, then add it in the right workspace location and connect it to the correct agent.",
  },
  {
    icon: DOCK_ICONS.files,
    label: 'New project',
    title: 'New project',
    prompt:
      "HEY let's set up a new project. Ask for the name and purpose, then create it in the right workspace location with a clean starting structure.",
  },
];

interface FilesSnapshot {
  selectedFile: SandboxFile | null;
  viewMode: 'list' | 'grid';
  showHidden: boolean;
}

const DEFAULT_FILES_SNAPSHOT: FilesSnapshot = {
  selectedFile: null,
  viewMode: 'list',
  showHidden: false,
};

export const PageContextMenuSheet = React.forwardRef<SheetRef, PageContextMenuSheetProps>(
  ({ target, workspaceRef, filesRef, onCreateSessionWithPrompt }, ref) => {
    const innerRef = React.useRef<SheetRef>(null);
    const [filesSnapshot, setFilesSnapshot] = React.useState<FilesSnapshot>(DEFAULT_FILES_SNAPSHOT);

    React.useImperativeHandle(ref, () => ({
      // Snapshot unconditionally: `target` in this closure is one render stale,
      // because callers setPageMenuTarget(...) and open() in the same tick.
      open: () => {
        setFilesSnapshot({
          selectedFile: filesRef.current?.selectedFile ?? null,
          viewMode: filesRef.current?.viewMode ?? 'list',
          showHidden: filesRef.current?.showHidden ?? false,
        });
        innerRef.current?.open();
      },
      close: () => innerRef.current?.close(),
    }));

    const runPrompt = React.useCallback((title: string, prompt: string) => {
      innerRef.current?.close();
      onCreateSessionWithPrompt(title, prompt);
    }, [onCreateSessionWithPrompt]);

    const runWorkspace = React.useCallback(
      (fn: (r: WorkspacePageRef) => void) => {
        innerRef.current?.close();
        if (workspaceRef.current) fn(workspaceRef.current);
      },
      [workspaceRef],
    );

    const runFiles = React.useCallback(
      (fn: (r: FilesPageRef) => void) => {
        innerRef.current?.close();
        if (filesRef.current) fn(filesRef.current);
      },
      [filesRef],
    );

    return (
      <Sheet ref={innerRef} enablePanDownToClose>
        {target ? (
          target.page === 'workspace' ? (
            <>
              <SheetHeader title="Workspace" />
              <SheetBody className="px-0 pb-2">
                {WORKSPACE_PROMPTS.map((entry) => (
                  <ListRow
                    key={entry.label}
                    title={entry.label}
                    left={<Icon as={entry.icon} size={18} className="text-foreground" />}
                    divider={false}
                    onPress={() => runPrompt(entry.title, entry.prompt)}
                  />
                ))}
                <Separator className="my-1" />
                <ListRow
                  title="Add MCP server"
                  left={<Icon as={Plug} size={18} className="text-foreground" />}
                  divider={false}
                  onPress={() => runWorkspace((r) => r.openSettings('mcp'))}
                />
                <ListRow
                  title="Settings"
                  left={<Icon as={DOCK_ICONS.settings} size={18} className="text-foreground" />}
                  divider={false}
                  onPress={() => runWorkspace((r) => r.openSettings('general'))}
                />
                <Separator className="my-1" />
                <ListRow
                  title="Refresh workspace"
                  left={<Icon as={RefreshCw} size={18} className="text-foreground" />}
                  divider={false}
                  onPress={() => runWorkspace((r) => r.refetch())}
                />
              </SheetBody>
            </>
          ) : (
            <>
              <SheetHeader title="Files" />
              <SheetBody className="px-0 pb-2">
                {filesSnapshot.selectedFile ? (
                  <View>
                    {/* Contextual actions for the selected file */}
                    <ListRow
                      title={`Open ${filesSnapshot.selectedFile.name}`}
                      left={<Icon as={FileText} size={18} className="text-foreground" />}
                      divider={false}
                      onPress={() =>
                        runFiles((r) => {
                          r.openFile();
                          r.deselectFile();
                        })
                      }
                    />
                    <ListRow
                      title="Copy path"
                      left={<Icon as={Copy} size={18} className="text-foreground" />}
                      divider={false}
                      onPress={() =>
                        runFiles((r) => {
                          r.copyPath();
                          r.deselectFile();
                        })
                      }
                    />
                    <ListRow
                      title="Rename"
                      left={<Icon as={DOCK_ICONS.rename} size={18} className="text-foreground" />}
                      divider={false}
                      onPress={() => runFiles((r) => r.renameFile())}
                    />
                    <ListRow
                      title="Delete"
                      left={<Icon as={DOCK_ICONS.delete} size={18} className="text-destructive" />}
                      divider={false}
                      variant="destructive"
                      onPress={() => runFiles((r) => r.deleteFile())}
                    />
                  </View>
                ) : (
                  <View>
                    {/* General file/view actions */}
                    <ListRow
                      title={filesSnapshot.viewMode === 'list' ? 'Grid view' : 'List view'}
                      left={
                        <Icon
                          as={filesSnapshot.viewMode === 'list' ? LayoutGrid : List}
                          size={18}
                          className="text-foreground"
                        />
                      }
                      divider={false}
                      onPress={() => runFiles((r) => r.toggleViewMode())}
                    />
                    <ListRow
                      title={filesSnapshot.showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
                      left={
                        <Icon
                          as={filesSnapshot.showHidden ? Eye : EyeOff}
                          size={18}
                          className="text-foreground"
                        />
                      }
                      divider={false}
                      onPress={() => runFiles((r) => r.toggleHidden())}
                    />
                    <ListRow
                      title="Upload file"
                      left={<Icon as={Upload} size={18} className="text-foreground" />}
                      divider={false}
                      onPress={() => runFiles((r) => r.uploadDocument())}
                    />
                    <ListRow
                      title="Upload image"
                      left={<Icon as={ImageIcon} size={18} className="text-foreground" />}
                      divider={false}
                      onPress={() => runFiles((r) => r.uploadImage())}
                    />
                    <ListRow
                      title="New file"
                      left={<Icon as={FilePlus} size={18} className="text-foreground" />}
                      divider={false}
                      onPress={() => runFiles((r) => r.createFile())}
                    />
                    <ListRow
                      title="New folder"
                      left={<Icon as={FolderPlus} size={18} className="text-foreground" />}
                      divider={false}
                      onPress={() => runFiles((r) => r.createFolder())}
                    />
                    <ListRow
                      title="Refresh"
                      left={<Icon as={RefreshCw} size={18} className="text-foreground" />}
                      divider={false}
                      onPress={() => runFiles((r) => r.refetch())}
                    />
                  </View>
                )}
              </SheetBody>
            </>
          )
        ) : null}
      </Sheet>
    );
  },
);
PageContextMenuSheet.displayName = 'PageContextMenuSheet';
