import { CaptureShell } from '@/features/capture/capture-shell';

/**
 * /projects/[id]/capture — Kortix Capture: Timeline, Ask, Ranges, Devices, and
 * for project managers People and Settings. The project's `capture` feature
 * flag gates the whole area (off → 404); the sidebar shows its entry only
 * while the flag is on.
 */
export default async function CaptureLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}) {
  const { id } = await params;
  return <CaptureShell projectId={id}>{children}</CaptureShell>;
}
