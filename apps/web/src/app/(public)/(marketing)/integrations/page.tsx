'use client';

import { Reveal } from '@/components/home/reveal';
import { LogoMarqueeRows } from '@/components/home/logo-marquee';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import {
  INTEGRATION_CATEGORIES,
  INTEGRATIONS,
} from '@/features/marketing/marketing-pages';
import { ArrowRight, Search } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { HiArrowRight } from 'react-icons/hi2';

const favicon = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`;
const CONNECTOR_TYPES = ['Apps', 'MCP', 'OpenAPI', 'GraphQL', 'HTTP'];

function IntegrationTile({ slug, name, domain, sub }: { slug: string; name: string; domain: string; sub: string }) {
  return (
    <Link
      href={`/integrations/${slug}`}
      className="border-border/70 bg-card hover:border-foreground/20 group flex items-center gap-3 rounded-md border p-3 transition-colors"
    >
      <span className="border-border bg-background flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border">
        <img src={favicon(domain)} alt={name} width={18} height={18} loading="lazy" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-sm font-medium">{name}</div>
        <div className="text-muted-foreground truncate text-xs">{sub}</div>
      </div>
      <ArrowRight className="text-muted-foreground/40 group-hover:text-foreground size-4 shrink-0 transition-colors" />
    </Link>
  );
}

export default function IntegrationsHub() {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const matches = useMemo(
    () =>
      INTEGRATIONS.filter(
        (i) =>
          !query ||
          i.name.toLowerCase().includes(query) ||
          i.category.toLowerCase().includes(query) ||
          i.domain.toLowerCase().includes(query),
      ),
    [query],
  );

  return (
    <main className="bg-background relative pt-32">
      <section className="mx-auto max-w-6xl px-6 lg:px-0">
        <Reveal>
          <Badge variant="update" className="rounded-full">
            Integrations
          </Badge>
          <h1 className="text-foreground mt-5 max-w-3xl text-4xl leading-[1.1] font-medium tracking-tight md:text-5xl">
            If it has an API, Kortix connects to it
          </h1>
          <p className="text-muted-foreground mt-6 max-w-xl text-lg leading-relaxed">
            3,000+ tools out of the box — plus any MCP, OpenAPI, GraphQL or raw HTTP endpoint.
            An admin connects an app once; it’s shared securely across the whole org, and it heals
            itself when a token expires.
          </p>
          <div className="mt-6 flex flex-wrap gap-1.5">
            {CONNECTOR_TYPES.map((t, i) => (
              <Badge key={t} variant={i === 0 ? 'highlight' : 'outline'}>
                {t}
              </Badge>
            ))}
          </div>
        </Reveal>
      </section>

      <section className="mt-14 overflow-hidden">
        <Reveal>
          <LogoMarqueeRows />
        </Reveal>
      </section>

      {/* Directory: search + category groups */}
      <section className="mx-auto mt-20 max-w-6xl px-6 pb-10 sm:mt-24 lg:px-0">
        <div className="border-border bg-card focus-within:border-foreground/30 mb-10 flex h-12 max-w-md items-center gap-2.5 rounded-sm border px-4 transition-colors">
          <Search className="text-muted-foreground size-4 shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search integrations…"
            className="placeholder:text-muted-foreground/60 text-foreground w-full bg-transparent text-sm outline-none"
          />
          {q && (
            <button
              onClick={() => setQ('')}
              className="text-muted-foreground hover:text-foreground text-xs"
            >
              Clear
            </button>
          )}
        </div>

        {query ? (
          matches.length > 0 ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {matches.map((it) => (
                <IntegrationTile key={it.slug} slug={it.slug} name={it.name} domain={it.domain} sub={it.category} />
              ))}
            </div>
          ) : (
            <div className="border-border/60 text-muted-foreground rounded-md border border-dashed py-10 text-center text-sm">
              No featured integration matches “{q}”. Kortix can still connect it via MCP, OpenAPI,
              GraphQL or HTTP.
            </div>
          )
        ) : (
          INTEGRATION_CATEGORIES.map((cat) => {
            const items = INTEGRATIONS.filter((i) => i.category === cat);
            if (items.length === 0) return null;
            return (
              <div key={cat} className="mb-12">
                <h2 className="text-foreground mb-4 text-sm font-semibold tracking-wide">{cat}</h2>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {items.map((it) => (
                    <IntegrationTile key={it.slug} slug={it.slug} name={it.name} domain={it.domain} sub={it.category} />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-28 lg:px-0">
        <Reveal>
          <div className="border-border bg-card flex flex-col items-start gap-5 rounded-sm border p-8 sm:p-12">
            <h2 className="text-foreground text-2xl font-medium tracking-tight sm:text-3xl">
              Don’t see your tool?
            </h2>
            <p className="text-muted-foreground max-w-xl text-base leading-relaxed">
              If it speaks MCP, OpenAPI, GraphQL or HTTP, Kortix can use it — and if there’s no
              connector yet, it can build one. Everything is code, so nothing is off-limits.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link href="/auth">
                  Get started <HiArrowRight className="size-4" />
                </Link>
              </Button>
              <Button size="lg" variant="secondary" asChild>
                <Link href="/developers">For developers</Link>
              </Button>
            </div>
          </div>
        </Reveal>
      </section>
    </main>
  );
}
