'use client';

import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
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
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { useAddMarketplaceSource, useFeaturedMarketplaces } from '@/hooks/marketplace';
import { MarketplaceAvatar } from './marketplace-avatar';
import { displayCompanyLabel } from './marketplace-company-filter';

/**
 * "Add a source" — pointing Kortix at any git registry is the primary action
 * (it's just git: a repo with SKILL.md / marketplace.json). Below that, a
 * searchable list of curated, one-click featured registries. Enabled items
 * merge into the catalog.
 */
export function AddMarketplaceModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const featuredQuery = useFeaturedMarketplaces({ enabled: open });
  const add = useAddMarketplaceSource();

  const [address, setAddress] = useState('');
  const [gitRef, setGitRef] = useState('');
  const [sparse, setSparse] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [search, setSearch] = useState('');
  const [enabling, setEnabling] = useState<string | null>(null);

  const featured = useMemo(() => {
    const base = (featuredQuery.data ?? []).filter((f) => !f.added);
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter((f) =>
      `${f.label} ${f.owner} ${f.description} ${f.address}`.toLowerCase().includes(q),
    );
  }, [featuredQuery.data, search]);

  const reset = () => {
    setAddress('');
    setGitRef('');
    setSparse('');
    setShowAdvanced(false);
    setSearch('');
  };

  const onAddCustom = () => {
    const addr = address.trim();
    if (!addr || add.isPending) return;
    const sparsePaths = sparse
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    add
      .mutateAsync({ address: addr, gitRef: gitRef.trim() || undefined, sparsePaths })
      .then(
        () => {
          successToast('Source added', { description: 'Its items now appear in the catalog.' });
          setAddress('');
          setGitRef('');
          setSparse('');
          setShowAdvanced(false);
        },
        (e) => errorToast('Could not add source', { description: (e as Error).message }),
      );
  };

  const onEnable = (addr: string, label: string) => {
    setEnabling(addr);
    add
      .mutateAsync({ address: addr, label })
      .then(
        () =>
          successToast(`Enabled ${label}`, {
            description: 'Its items now appear in the catalog.',
          }),
        (e) => errorToast('Could not enable', { description: (e as Error).message }),
      )
      .finally(() => setEnabling(null));
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>Add a source</ModalTitle>
          <ModalDescription>
            Point Kortix at any git repo with a <span className="font-mono">SKILL.md</span> /{' '}
            <span className="font-mono">marketplace.json</span> — or enable a curated one below.
          </ModalDescription>
        </ModalHeader>

        <ModalBody className="max-h-[62vh] space-y-5 overflow-y-auto">
          {/* Primary: add any git source */}
          <div className="space-y-3">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="mp-address">Git source</FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id="mp-address"
                  className="flex-1"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      onAddCustom();
                    }
                  }}
                  placeholder="owner/repo or https://…"
                  autoFocus
                />
                <Button
                  className="shrink-0"
                  onClick={onAddCustom}
                  disabled={!address.trim() || add.isPending}
                >
                  {add.isPending && !enabling ? <Loading className="size-4 shrink-0" /> : null}
                  Add
                </Button>
              </div>
              <FieldDescription>
                Any public repo with skills. e.g. anthropics/skills or garrytan/gstack.
              </FieldDescription>
            </Field>

            {showAdvanced ? (
              <div className="grid grid-cols-2 gap-3">
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="mp-ref">
                    Git ref <span className="text-muted-foreground font-normal">(optional)</span>
                  </FieldLabel>
                  <Input
                    id="mp-ref"
                    value={gitRef}
                    onChange={(e) => setGitRef(e.target.value)}
                    placeholder="main"
                  />
                </Field>
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="mp-sparse">
                    Sparse path{' '}
                    <span className="text-muted-foreground font-normal">(optional)</span>
                  </FieldLabel>
                  <Input
                    id="mp-sparse"
                    value={sparse}
                    onChange={(e) => setSparse(e.target.value)}
                    placeholder="plugins/codex"
                  />
                </Field>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowAdvanced(true)}
                className="text-muted-foreground hover:text-foreground text-xs transition-colors"
              >
                Advanced — git ref, sparse path
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-muted-foreground/70 text-xs font-medium tracking-wide uppercase">
              Or enable a curated source
            </span>
            <Separator className="flex-1" />
          </div>

          {/* Secondary: curated featured sources */}
          <div className="space-y-3">
            <InputGroupSearch>
              <InputGroupSearchIcon>
                <Search />
              </InputGroupSearchIcon>
              <InputGroupSearchInput
                placeholder="Search curated sources"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                variant="popover"
              />
              <InputGroupSearchClear onClick={() => setSearch('')} />
            </InputGroupSearch>

            {featuredQuery.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 rounded-md" />
                ))}
              </div>
            ) : featured.length === 0 ? (
              <p className="text-muted-foreground/70 py-6 text-center text-sm">
                {search ? `No sources match “${search}”.` : 'All curated sources are enabled.'}
              </p>
            ) : (
              <div className="space-y-2">
                {featured.map((f) => (
                  <div
                    key={f.address}
                    className="bg-popover flex items-center gap-3 rounded-md border px-3 py-2.5"
                  >
                    <MarketplaceAvatar id={f.address} owner={f.owner} label={f.label} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground truncate text-sm font-medium">
                        {displayCompanyLabel(f.address, f.label)}
                      </div>
                      <div className="text-muted-foreground truncate text-xs">
                        {f.description || f.address}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="shrink-0"
                      disabled={enabling === f.address}
                      onClick={() => onEnable(f.address, f.label)}
                    >
                      {enabling === f.address ? <Loading className="size-3.5 shrink-0" /> : 'Enable'}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ModalBody>

        <ModalFooter>
          <Button variant="outline-ghost" size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
