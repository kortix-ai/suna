'use client';

import { CaretDownIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';

import type { ConnectorTechnicalRow } from './connector-detail-copy';

export function ConnectorAdvanced({
  rows,
  headers = {},
  defaultOpen = false,
}: {
  rows: readonly ConnectorTechnicalRow[];
  headers?: Readonly<Record<string, string>>;
  defaultOpen?: boolean;
}) {
  if (rows.length === 0 && Object.keys(headers).length === 0) return null;

  return (
    <Disclosure variant="outline" defaultOpen={defaultOpen}>
      <DisclosureTrigger variant="outline">
        <Button
          variant="popover"
          className="group/trigger flex w-full items-center justify-between rounded-none px-4 py-3"
        >
          <span className="text-foreground text-base font-medium sm:text-sm">Advanced</span>
          <CaretDownIcon className="size-4 shrink-0 group-aria-expanded/trigger:rotate-180" />
        </Button>
      </DisclosureTrigger>
      <DisclosureContent variant="outline" contentClassName="border-border border-t">
        <div className="space-y-5 px-4 py-5">
          {rows.length > 0 ? (
            <dl className="space-y-3">
              {rows.map((row) => (
                <div
                  key={row.label}
                  className="grid min-w-0 gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4"
                >
                  <dt className="text-foreground text-base font-medium sm:text-sm">{row.label}</dt>
                  <dd className="text-muted-foreground min-w-0 font-mono text-base break-words sm:text-sm">
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}

          {Object.keys(headers).length > 0 ? (
            <section className="space-y-2" aria-labelledby="request-headers-title">
              <h3 id="request-headers-title" className="text-foreground text-sm font-medium">
                Request headers
              </h3>
              <div className="bg-muted/40 overflow-x-auto rounded-md border p-3 font-mono text-sm">
                {Object.entries(headers).map(([name, value]) => (
                  <div key={name} className="grid min-w-max grid-cols-[auto_1fr] gap-2">
                    <span className="text-foreground">{name}:</span>
                    <span className="text-muted-foreground">{value}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}
