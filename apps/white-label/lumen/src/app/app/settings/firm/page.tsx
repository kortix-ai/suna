'use client';

import { useFirm } from '@/components/access';
import { FirmLogo } from '@/components/app-shell';
import { SIZE_BANDS, TagsInput } from '@/components/firm-fields';
import { isAdmin } from '@/lib/roles';
import { errorText } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kortix/ui/select';
import { errorToast, successToast } from '@kortix/ui/toast';
import { UploadSimpleIcon } from '@phosphor-icons/react';
import { useAction, useMutation } from 'convex/react';
import { useRef, useState } from 'react';

const LOGO_MAX_BYTES = 1024 * 1024;
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];

export default function FirmSettings() {
  const firm = useFirm();
  const admin = isAdmin(firm.role);
  const update = useMutation(api.firms.update);
  const setLogo = useAction(api.firms.setLogo);
  const [name, setName] = useState(firm.name);
  const [jurisdiction, setJurisdiction] = useState(firm.jurisdiction ?? '');
  const [sizeBand, setSizeBand] = useState(firm.sizeBand);
  const [tags, setTags] = useState(firm.practiceTags);
  const [pending, setPending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await update({ firmId: firm._id, name, jurisdiction, sizeBand, practiceTags: tags });
      successToast('Firm settings saved');
    } catch (err) {
      errorToast('Could not save', { description: errorText(err) });
    } finally {
      setPending(false);
    }
  }

  async function uploadLogo(f: File) {
    if (!LOGO_TYPES.includes(f.type) || f.size > LOGO_MAX_BYTES) {
      errorToast('Use a PNG, JPEG, SVG or WebP image up to 1 MB');
      return;
    }
    setUploading(true);
    try {
      await setLogo({ firmId: firm._id, bytes: await f.arrayBuffer(), contentType: f.type });
      successToast('Logo updated');
    } catch (err) {
      errorToast('Could not upload the logo', { description: errorText(err) });
    } finally {
      setUploading(false);
    }
  }

  return (
    <form onSubmit={save} className="max-w-xl space-y-6">
      {!admin && <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">Only owners and admins change firm settings.</p>}
      <fieldset disabled={!admin} className="space-y-5">
        <div className="flex items-center gap-4">
          <FirmLogo firm={firm} className="size-14 text-2xl" />
          <div>
            <Input
              ref={file}
              type="file"
              accept={LOGO_TYPES.join(',')}
              className="hidden"
              aria-label="Logo file"
              onChange={(e) => e.target.files?.[0] && uploadLogo(e.target.files[0])}
            />
            <Button type="button" variant="secondary" size="sm" disabled={!admin || uploading} onClick={() => file.current?.click()}>
              {uploading ? <Loading className="size-4" /> : <UploadSimpleIcon className="size-4" />} Upload logo
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">Shown in the sidebar for everyone at the firm.</p>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="firm-name">Firm name</Label>
          <Input id="firm-name" required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="firm-jurisdiction">Default jurisdiction</Label>
            <Input id="firm-jurisdiction" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} placeholder="England and Wales" />
          </div>
          <div className="space-y-1.5">
            <Label>Firm size</Label>
            <Select value={sizeBand} onValueChange={(v) => setSizeBand(v as typeof sizeBand)}>
              <SelectTrigger aria-label="Firm size" className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SIZE_BANDS.map((b) => (
                  <SelectItem key={b.value} value={b.value}>
                    {b.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <TagsInput value={tags} onChange={setTags} />
        <div className="rounded-lg border border-border px-4 py-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Workspace</span>
            <span>{firm.status === 'ready' ? 'Ready' : firm.status === 'failed' ? 'Setup failed' : 'Setting up…'}</span>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-muted-foreground">Legal agents</span>
            <span className="font-mono text-xs" data-testid="kit-version">{firm.kitVersion ?? 'Installs with the first run'}</span>
          </div>
        </div>
      </fieldset>
      {admin && (
        <Button type="submit" disabled={pending}>
          {pending && <Loading className="size-4" />} Save changes
        </Button>
      )}
    </form>
  );
}
