'use client';

import { useFirm } from '@/components/access';
import { AdminOnly } from '@/components/admin-only';
import { downloadCsv } from '@/lib/csv';
import { api } from '@convex/_generated/api';
import { Button } from '@kortix/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kortix/ui/select';
import { Skeleton } from '@kortix/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@kortix/ui/table';
import { DownloadSimpleIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from 'convex/react';
import { useState } from 'react';

const ACTIONS: Record<string, string> = {
  'firm.create': 'Firm created',
  'firm.ready': 'Workspace ready',
  'firm.failed': 'Workspace setup failed',
  'firm.update': 'Firm settings changed',
  'member.invite': 'Member invited',
  'member.join': 'Member joined',
  'member.role': 'Role changed',
  'member.remove': 'Member removed',
  'member.invite_cancel': 'Invitation revoked',
  'matter.create': 'Matter created',
  'matter.update': 'Matter updated',
  'matter.close': 'Matter closed',
  'thread.create': 'Conversation started',
  'thread.delete': 'Conversation deleted',
  'token.mint': 'Workspace access granted',
  'billing.plan': 'Plan changed',
  'billing.checkout': 'Checkout started',
  'export.csv': 'Data exported',
  'export.docx': 'Document downloaded',
  'document.upload': 'Document uploaded',
  'document.delete': 'Document deleted',
  'run.start': 'Run started',
  'run.finish': 'Run finished',
  'run.cancel': 'Run canceled',
  'kit.install': 'Legal agents updated',
  'cell.verify': 'Cell verified',
  'cell.flag': 'Cell flagged',
  'cell.edit': 'Cell edited',
  'issue.accept': 'Issue accepted',
  'issue.dismiss': 'Issue dismissed',
  'library.create': 'Library item created',
  'library.update': 'Library item edited',
};

const SYSTEM: Record<string, string> = { system: 'Lumen', operator: 'Lumen operator', stripe: 'Billing' };

export default function AuditPage() {
  return (
    <AdminOnly>
      <Audit />
    </AdminOnly>
  );
}

function Audit() {
  const firm = useFirm();
  const [action, setAction] = useState('all');
  const [actor, setActor] = useState('all');
  const [matter, setMatter] = useState('all');
  const rows = useQuery(api.audit.list, { firmId: firm._id, ...(action !== 'all' ? { action: action as never } : {}) });
  const directory = useQuery(api.members.directory, { firmId: firm._id });
  const logExport = useMutation(api.audit.logExport);
  const actorName = (id: string) => SYSTEM[id] ?? directory?.find((d) => d.userId === id)?.email ?? id.slice(0, 8);
  const matters = [...new Map((rows ?? []).filter((r) => r.matterId).map((r) => [r.matterId!, r.matterName ?? ''])).entries()];
  const shown = (rows ?? []).filter((r) => (actor === 'all' || r.actorId === actor) && (matter === 'all' || r.matterId === matter));

  function exportCsv() {
    downloadCsv('lumen-audit-log.csv', [
      ['time', 'actor', 'action', 'matter', 'detail'],
      ...shown.map((r) => [new Date(r._creationTime).toISOString(), actorName(r.actorId), ACTIONS[r.action] ?? r.action, r.matterName ?? '', r.detail ?? '']),
    ]);
    void logExport({ firmId: firm._id, what: 'audit log' });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger aria-label="Filter by action" className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {Object.entries(ACTIONS).map(([k, label]) => (
              <SelectItem key={k} value={k}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={actor} onValueChange={setActor}>
          <SelectTrigger aria-label="Filter by actor" className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everyone</SelectItem>
            {directory?.map((d) => (
              <SelectItem key={d.userId} value={d.userId}>
                {d.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={matter} onValueChange={setMatter}>
          <SelectTrigger aria-label="Filter by matter" className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All matters</SelectItem>
            {matters.map(([id, name]) => (
              <SelectItem key={id} value={id}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={exportCsv} disabled={shown.length === 0}>
          <DownloadSimpleIcon className="size-4" /> Export CSV
        </Button>
      </div>
      <div className="rounded-xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-44">Time</TableHead>
              <TableHead className="w-56">Who</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Matter</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows === undefined && (
              <TableRow>
                <TableCell colSpan={4}>
                  <Skeleton className="h-5" />
                </TableCell>
              </TableRow>
            )}
            {rows && shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  No events match these filters.
                </TableCell>
              </TableRow>
            )}
            {shown.map((r) => (
              <TableRow key={r._id} data-action={r.action}>
                <TableCell className="font-mono text-xs text-muted-foreground">{new Date(r._creationTime).toLocaleString()}</TableCell>
                <TableCell className="truncate">{actorName(r.actorId)}</TableCell>
                <TableCell>
                  <span>{ACTIONS[r.action] ?? r.action}</span>
                  {r.detail && <span className="ml-2 text-xs text-muted-foreground">{r.detail}</span>}
                </TableCell>
                <TableCell className="text-muted-foreground">{r.matterName ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
