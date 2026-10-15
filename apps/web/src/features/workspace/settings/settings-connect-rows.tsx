'use client';

/**
 * "Connect MCP" and "Connect your computer" at the foot of the settings rail:
 * the same two rows the project sidebar footer shows
 * (`project-sidebar/footer/project-{mcp,computer}-nav.tsx`), drawn the same
 * way — one block, 1px seam, a "New" badge.
 *
 * There they are promos a person can dismiss, and a dismissed promo left no
 * way back to either dialog. Here they cannot be dismissed: this is the entry
 * point that stays (KRTX-1997). The computer row keeps the promo's gate — it
 * hides once the person owns a paired machine, and with no project open,
 * because the dialog pairs a machine for a project.
 *
 * Plain buttons, not `SidebarMenuButton`: the settings overlay does not sit
 * under the project sidebar's provider on every route.
 */

import { LaptopIcon } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';

import Loading from '@/components/ui/loading';
import { Mcp } from '@/features/icon/icons/mcp';
import { ConnectMcpModal } from '@/features/layout/connect-mcp-modal';
import {
  ComputerConnectModal,
  useConnectDesktopComputer,
  useOwnsPairedComputer,
  useThisComputerState,
} from '@/features/tunnel/computer-connect';
import { useTranslations } from '@/i18n/use-translations';

const ROW =
  'bg-hover text-sidebar-foreground hover:bg-active flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-sm font-medium outline-none focus-visible:ring-kortix-base focus-visible:ring-[0.6px] disabled:pointer-events-none disabled:opacity-50';

function ConnectRow({
  icon,
  label,
  onClick,
  pending = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  pending?: boolean;
}) {
  const tSidebar = useTranslations('sidebar');
  return (
    <li>
      <button type="button" className={ROW} onClick={onClick} disabled={pending} aria-busy={pending}>
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="bg-kortix-blue/15 text-kortix-blue flex h-5 shrink-0 items-center rounded-sm px-1.5 text-xs font-medium">
          {tSidebar('new')}
        </span>
      </button>
    </li>
  );
}

function ComputerRow({ projectId }: { projectId: string }) {
  const t = useTranslations('computers');
  const [open, setOpen] = useState(false);
  const paired = useOwnsPairedComputer();
  // `oneClick`: the desktop app pairs this machine in place; otherwise the
  // dialog offers the download and the CLI. `stale`: re-pair a local pairing
  // this backend does not list.
  const { desktop, oneClick, stale } = useThisComputerState();
  const connectDesktop = useConnectDesktopComputer(projectId);

  if (!paired.isSuccess || paired.owns || desktop.isPending) return null;

  return (
    <>
      <ConnectRow
        icon={
          connectDesktop.isPending ? (
            <Loading className="size-4 shrink-0" />
          ) : (
            <LaptopIcon className="text-muted-foreground size-4 shrink-0" />
          )
        }
        label={
          connectDesktop.isPending
            ? t('connecting')
            : oneClick
              ? t('connectThisComputer')
              : t('connectYourComputer')
        }
        pending={connectDesktop.isPending}
        onClick={() => (oneClick ? connectDesktop.mutate({ reauth: stale }) : setOpen(true))}
      />
      <ComputerConnectModal projectId={projectId} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function SettingsConnectRows({ projectId }: { projectId?: string }) {
  const tSidebar = useTranslations('sidebar');
  const [mcpOpen, setMcpOpen] = useState(false);

  return (
    <div className="shrink-0 px-2 pb-2">
      <ul className="flex flex-col gap-px [&>li:not(:first-child)>button]:rounded-t-sm [&>li:not(:last-child)>button]:rounded-b-sm">
        <ConnectRow
          icon={<Mcp className="text-muted-foreground size-4 shrink-0" />}
          label={tSidebar('workspace.connectMcp')}
          onClick={() => setMcpOpen(true)}
        />
        {projectId ? <ComputerRow projectId={projectId} /> : null}
      </ul>
      <ConnectMcpModal open={mcpOpen} onOpenChange={setMcpOpen} />
    </div>
  );
}
