'use client';

import { Input } from '@/components/ui/input';
import { SubmitButton } from '../ui/submit-button';
import { editTeamSlug } from '@/lib/actions/teams';
import { Label } from '../ui/label';
import { GetAccountResponse } from '@usebasejump/shared';

type Props = {
  account: GetAccountResponse;
};

export default function EditTeamSlug({ account }: Props) {
  return (
    <form className="animate-in">
      <input type="hidden" name="accountId" value={account.account_id} />
      <div className="flex flex-col gap-y-4">
        <div className="flex flex-col gap-y-2">
          <Label
            htmlFor="slug"
            className="text-sm font-medium text-foreground/90"
          >
            Team URL Identifier
          </Label>
          <div className="flex items-center gap-x-2">
            <span className="text-sm text-foreground/70 whitespace-nowrap">
              https://your-app.com/
            </span>
            <Input
              defaultValue={account.slug}
              name="slug"
              id="slug"
              placeholder="my-team"
              required
              className="h-10 rounded-lg border-subtle dark:border-white/10 bg-white dark:bg-background-secondary"
            />
          </div>
        </div>
        <div className="flex justify-end mt-2">
          <SubmitButton
            formAction={editTeamSlug}
            pendingText="Updating..."
            className="rounded-lg bg-primary hover:bg-primary/90 text-white h-10"
          >
            Save Changes
          </SubmitButton>
        </div>
      </div>
    </form>
  );
}
