import { Input } from '@/components/ui/input';
import { SubmitButton } from '../ui/submit-button';
import { editTeamName } from '@/lib/actions/teams';
import { Label } from '../ui/label';
import { GetAccountResponse } from '@usebasejump/shared';

type Props = {
  account: GetAccountResponse;
};

export default function EditTeamName({ account }: Props) {
  return (
    <form className="animate-in">
      <input type="hidden" name="accountId" value={account.account_id} />
      <div className="flex flex-col gap-y-4">
        <div className="flex flex-col gap-y-2">
          <Label
            htmlFor="name"
            className="text-sm font-medium text-foreground/90"
          >
            Team Name
          </Label>
          <Input
            defaultValue={account.name}
            name="name"
            id="name"
            placeholder="My Team"
            required
            className="h-10 rounded-lg border-subtle dark:border-white/10 bg-white dark:bg-background-secondary"
          />
        </div>
        <div className="flex justify-end mt-2">
          <SubmitButton
            formAction={editTeamName}
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
