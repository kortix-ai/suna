'use client';

import { Plus, Radio, Trash2, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import {
  useDeleteGatewayOtelConfig,
  useGatewayOtelConfig,
  useSetGatewayOtelConfig,
} from '@/hooks/projects/use-project-gateway';

/** One row of the "connect any tool" cheat sheet — not exhaustive, and the
 *  exact endpoint/header shape can change on the vendor's side, so this reads
 *  as a starting point, not a promise. */
const DESTINATIONS: {
  name: string;
  blurb: string;
  endpointHint: string;
  headerHint: string;
}[] = [
  {
    name: 'Langfuse',
    blurb: 'LLM observability + evals',
    endpointHint: 'https://cloud.langfuse.com/api/public/otel/v1/traces',
    headerHint: 'Authorization = Basic base64(public_key:secret_key)',
  },
  {
    name: 'Datadog',
    blurb: 'APM + LLM Observability',
    endpointHint: 'your Datadog OTLP intake (e.g. https://otlp.datadoghq.com/v1/traces)',
    headerHint: 'DD-API-KEY = your Datadog API key',
  },
  {
    name: 'Honeycomb',
    blurb: 'Traces + AI observability',
    endpointHint: 'https://api.honeycomb.io/v1/traces',
    headerHint: 'x-honeycomb-team = your Honeycomb API key',
  },
  {
    name: 'Braintrust',
    blurb: 'Evals + LLM tracing',
    endpointHint: 'https://api.braintrust.dev/otel/v1/traces',
    headerHint: 'Authorization = Bearer your_braintrust_api_key',
  },
];

/** The gen_ai.* semantic-convention + kortix.* custom attributes every span
 *  carries — kept in sync by hand with hooks.ts's emitGatewayGenAiSpan. */
const SPAN_ATTRIBUTES = [
  { key: 'gen_ai.system', desc: 'the upstream provider (e.g. anthropic, openai, bedrock)' },
  { key: 'gen_ai.request.model', desc: 'the model you requested' },
  { key: 'gen_ai.response.model', desc: 'the model that actually served the call' },
  { key: 'gen_ai.usage.input_tokens', desc: 'prompt tokens' },
  { key: 'gen_ai.usage.output_tokens', desc: 'completion tokens' },
  { key: 'kortix.cost_usd', desc: 'what this call was billed' },
  { key: 'kortix.upstream_cost_usd', desc: 'what the upstream provider charged' },
  { key: 'kortix.latency_ms', desc: 'span duration (start → end)' },
  { key: 'kortix.request_id', desc: 'ties the span back to this project’s Logs tab' },
];

interface HeaderRow {
  id: string;
  name: string;
  value: string;
}

function emptyHeaderRow(): HeaderRow {
  return { id: crypto.randomUUID(), name: '', value: '' };
}

export function GatewayObservability({
  projectId,
  canWrite = false,
}: {
  projectId: string;
  canWrite?: boolean;
}) {
  const { data, isLoading } = useGatewayOtelConfig(projectId);
  const setConfig = useSetGatewayOtelConfig(projectId);
  const deleteConfig = useDeleteGatewayOtelConfig(projectId);

  const [formOpen, setFormOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  const configuredEndpoint = data?.endpoint || null;
  // The coarse customize-write flag, narrowed by the server's own per-capability
  // check on this response — mirrors gateway-routing.tsx's `writable` pattern so
  // a future custom role that has customize.write but not gateway.otel.manage
  // renders read-only instead of firing a 403 on save.
  const writable = canWrite && data?.capabilities?.write !== false;

  const toggleEnabled = (next: boolean) => {
    if (!data?.endpoint) return;
    setConfig.mutate(
      { enabled: next, endpoint: data.endpoint },
      {
        onSuccess: () => successToast(next ? 'Export enabled' : 'Export paused'),
        onError: (e) => errorToast(e instanceof Error ? e.message : 'Could not update export'),
      },
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="w-full space-y-4 p-5">
        <section className="space-y-3">
          <div className="min-w-0">
            <Label>Export traces</Label>
            <p className="text-muted-foreground mt-0.5 text-pretty text-xs">
              Point the gateway&apos;s per-call OpenTelemetry spans at your own OTLP-compatible
              backend — Langfuse, Datadog, Honeycomb, Braintrust, or anything else that speaks OTLP.
              Every LLM call already logged in the Logs tab also becomes a trace there.
            </p>
          </div>

          {isLoading ? null : configuredEndpoint && data ? (
            <ConfiguredPanel
              endpoint={configuredEndpoint}
              enabled={data.enabled}
              hasHeaders={data.has_headers}
              updatedAt={data.updated_at}
              canWrite={writable}
              pending={setConfig.isPending}
              onToggle={toggleEnabled}
              onEdit={() => setFormOpen(true)}
              onDisconnect={() => setDisconnectOpen(true)}
            />
          ) : (
            <EmptyState
              icon={Radio}
              size="sm"
              title="No export destination connected"
              description="Connect an OTLP endpoint to start streaming gen_ai.* spans out of Kortix."
              action={
                writable ? (
                  <Button variant="outline" size="sm" onClick={() => setFormOpen(true)}>
                    Connect a destination
                  </Button>
                ) : undefined
              }
            />
          )}
        </section>

        <Panel title="What gets sent" description="One span per gateway call">
          <ul className="divide-border/60 divide-y">
            {SPAN_ATTRIBUTES.map((attr) => (
              <li
                key={attr.key}
                className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0"
              >
                <code className="text-foreground shrink-0 font-mono text-xs">{attr.key}</code>
                <span className="text-muted-foreground text-right text-xs text-pretty">
                  {attr.desc}
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel
          title="Connect any tool"
          description="Typical endpoint + auth header — confirm the exact value in your account"
        >
          <div className="space-y-2">
            {DESTINATIONS.map((d) => (
              <div key={d.name} className="flex items-start gap-3 rounded-md border px-3 py-2.5">
                <EntityAvatar label={d.name} size="sm" className="mt-0.5" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-foreground text-sm font-medium">{d.name}</span>
                    <span className="text-muted-foreground text-xs">{d.blurb}</span>
                  </div>
                  <code className="text-muted-foreground block truncate font-mono text-xs">
                    {d.endpointHint}
                  </code>
                  <code className="text-muted-foreground block truncate font-mono text-xs">
                    {d.headerHint}
                  </code>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {formOpen && (
        <ObservabilityFormModal
          initialEndpoint={data?.endpoint ?? ''}
          initialEnabled={data?.endpoint ? data.enabled : true}
          hasStoredHeaders={data?.has_headers ?? false}
          saving={setConfig.isPending}
          onClose={() => setFormOpen(false)}
          onSave={(input) =>
            setConfig.mutate(input, {
              onSuccess: () => {
                successToast('Export destination saved');
                setFormOpen(false);
              },
              onError: (e) => errorToast(e instanceof Error ? e.message : 'Could not save'),
            })
          }
        />
      )}

      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title="Disconnect export"
        description="Kortix stops sending gen_ai.* spans to this destination. Your Logs and Overview tabs are unaffected — this only turns off the OTLP export."
        confirmLabel="Disconnect"
        confirmVariant="destructive"
        onConfirm={() =>
          deleteConfig.mutate(undefined, {
            onSuccess: () => {
              setDisconnectOpen(false);
              successToast('Export destination removed');
            },
            onError: (e) => errorToast(e instanceof Error ? e.message : 'Could not disconnect'),
          })
        }
        isPending={deleteConfig.isPending}
      />
    </div>
  );
}

function ConfiguredPanel({
  endpoint,
  enabled,
  hasHeaders,
  updatedAt,
  canWrite,
  pending,
  onToggle,
  onEdit,
  onDisconnect,
}: {
  endpoint: string;
  enabled: boolean;
  hasHeaders: boolean;
  updatedAt: string | null;
  canWrite: boolean;
  pending: boolean;
  onToggle: (next: boolean) => void;
  onEdit: () => void;
  onDisconnect: () => void;
}) {
  const hostname = endpointHostname(endpoint);
  return (
    <div className="bg-popover flex items-start gap-3 rounded-md border px-4 py-3">
      <EntityAvatar label={hostname} size="md" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground truncate text-sm font-medium">{hostname}</span>
          <Badge size="sm" variant={enabled ? 'success' : 'secondary'}>
            {enabled ? 'Exporting' : 'Paused'}
          </Badge>
          {hasHeaders && (
            <Badge size="sm" variant="outline">
              Auth header set
            </Badge>
          )}
        </div>
        <code className="text-muted-foreground mt-0.5 block truncate font-mono text-xs">
          {endpoint}
        </code>
        <InlineMeta className="mt-1">
          {updatedAt && <span>updated {new Date(updatedAt).toLocaleDateString()}</span>}
        </InlineMeta>
      </div>
      {canWrite && (
        <div className="flex shrink-0 items-center gap-3">
          <Switch checked={enabled} disabled={pending} onCheckedChange={onToggle} />
          <Button size="sm" variant="ghost" onClick={onEdit}>
            Edit
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Disconnect" onClick={onDisconnect}>
            <Trash2 className="size-3.5 shrink-0" />
          </Button>
        </div>
      )}
    </div>
  );
}

/** The endpoint's hostname for display (avatar initial + row title), or the
 *  raw string if it doesn't parse as a URL — should never happen for a value
 *  the server already accepted, but display code must not throw on it. */
export function endpointHostname(value: string): string {
  try {
    return new URL(value).hostname || value;
  } catch {
    return value;
  }
}

/** The gateway only ever accepts https:// destinations (see the API's
 *  assertSafeEgressUrl SSRF guard) — mirrored client-side so the Save button
 *  can't even be pressed for a value the server would reject. */
export function isValidOtelEndpoint(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Rows with at least one non-blank field — an all-blank row is "not filled
 *  in", not "a header named empty string". */
export function activeHeaderRows(rows: HeaderRow[]): HeaderRow[] {
  return rows.filter((r) => r.name.trim() || r.value.trim());
}

/** True only when every ACTIVE row has both a name and a value — a row with
 *  just a name (or just a value) is a half-filled mistake, not a header to
 *  send or silently drop. */
export function headerRowsValid(rows: HeaderRow[]): boolean {
  return activeHeaderRows(rows).every((r) => r.name.trim() && r.value.trim());
}

/** The PUT payload's `headers` field: `undefined` when nothing is filled in
 *  (leave whatever the project already has stored untouched — see the API's
 *  "omit to leave headers untouched" contract), otherwise the full
 *  name→value replacement. Assumes `headerRowsValid(rows)` was already
 *  checked — an invalid half-filled row here would silently drop a field. */
export function buildHeadersPayload(rows: HeaderRow[]): Record<string, string> | undefined {
  const active = activeHeaderRows(rows);
  if (active.length === 0) return undefined;
  return Object.fromEntries(active.map((r) => [r.name.trim(), r.value.trim()]));
}

function ObservabilityFormModal({
  initialEndpoint,
  initialEnabled,
  hasStoredHeaders,
  saving,
  onClose,
  onSave,
}: {
  initialEndpoint: string;
  /** The destination's current on/off state — preserved on save so fixing a
   *  typo in the endpoint from the Edit flow never silently re-enables a
   *  destination the project paused. */
  initialEnabled: boolean;
  hasStoredHeaders: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (input: {
    enabled: boolean;
    endpoint: string;
    headers?: Record<string, string>;
  }) => void;
}) {
  const [endpoint, setEndpoint] = useState(initialEndpoint);
  const [rows, setRows] = useState<HeaderRow[]>([
    { id: crypto.randomUUID(), name: 'Authorization', value: '' },
  ]);

  const trimmedEndpoint = endpoint.trim();
  const endpointValid = isValidOtelEndpoint(trimmedEndpoint);
  const rowsValid = headerRowsValid(rows);

  const submit = () => {
    if (!endpointValid || !rowsValid) return;
    onSave({
      enabled: initialEnabled,
      endpoint: trimmedEndpoint,
      headers: buildHeadersPayload(rows),
    });
  };

  return (
    <Modal open onOpenChange={(next) => (next ? undefined : onClose())}>
      <ModalContent className="sm:max-w-lg">
        <ModalHeader>
          <ModalTitle>
            {initialEndpoint ? 'Edit export destination' : 'Connect a destination'}
          </ModalTitle>
          <ModalDescription>
            An OTLP/HTTP traces endpoint — the gateway POSTs one span per call here.
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
          <div className="space-y-1.5">
            <Label htmlFor="otel-endpoint">Endpoint URL</Label>
            <Input
              id="otel-endpoint"
              autoFocus
              placeholder="https://your-otlp-collector.example.com/v1/traces"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              variant="popover"
            />
            {trimmedEndpoint && !endpointValid && (
              <p className="text-destructive text-xs">Must be an https:// URL.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Auth headers</Label>
              {rows.length < 8 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 gap-1 px-1.5 text-xs"
                  onClick={() => setRows((r) => [...r, emptyHeaderRow()])}
                >
                  <Plus className="size-3 shrink-0" />
                  Add header
                </Button>
              )}
            </div>
            {hasStoredHeaders && (
              <p className="text-muted-foreground text-xs text-pretty">
                A header is already stored. Leave these blank to keep it, or fill both fields to
                replace it.
              </p>
            )}
            <div className="space-y-2">
              {rows.map((row) => (
                <div key={row.id} className="flex items-center gap-2">
                  <Input
                    placeholder="Authorization"
                    value={row.name}
                    onChange={(e) =>
                      setRows((r) =>
                        r.map((x) => (x.id === row.id ? { ...x, name: e.target.value } : x)),
                      )
                    }
                    variant="popover"
                    className="w-40 shrink-0 font-mono text-xs"
                  />
                  <Input
                    placeholder="Bearer sk-…"
                    value={row.value}
                    onChange={(e) =>
                      setRows((r) =>
                        r.map((x) => (x.id === row.id ? { ...x, value: e.target.value } : x)),
                      )
                    }
                    variant="popover"
                    className="flex-1 font-mono text-xs"
                  />
                  {rows.length > 1 && (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Remove header"
                      onClick={() => setRows((r) => r.filter((x) => x.id !== row.id))}
                    >
                      <X className="size-3.5 shrink-0" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
            {!rowsValid && (
              <p className="text-destructive text-xs">
                Fill in both the header name and value, or remove the row.
              </p>
            )}
          </div>

          <InfoBanner tone="neutral">
            Headers are encrypted at rest, the same as a project secret, and are never shown again
            after you save.
          </InfoBanner>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button type="button" variant="outline-ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!endpointValid || !rowsValid || saving} onClick={submit}>
            {saving ? <Loading className="size-4 shrink-0" /> : null}
            Save
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/**
 * Hand-composed panel — the design-system `bg-popover rounded-md border`
 * surface (replaces the deprecated SectionCard).
 */
function Panel({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="bg-popover overflow-hidden rounded-md border">
      <div className="border-border/60 border-b px-4 py-3">
        <h3 className="text-foreground text-sm font-medium">{title}</h3>
        {description != null && (
          <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{description}</p>
        )}
      </div>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}
