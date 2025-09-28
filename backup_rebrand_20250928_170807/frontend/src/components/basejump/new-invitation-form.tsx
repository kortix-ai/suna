'use client';
import { SubmitButton } from '../ui/submit-button';
import { Label } from '../ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
} from '@/components/ui/select';
import { createInvitation } from '@/lib/actions/invitations';
import { useFormState } from 'react-dom';
import fullInvitationUrl from '@/lib/full-invitation-url';

type Props = {
  accountId: string;
};

const invitationOptions = [
  { label: '24 Hour', value: '24_hour' },
  { label: 'One time use', value: 'one_time' },
];

const memberOptions = [
  { label: 'Owner', value: 'owner' },
  { label: 'Member', value: 'member' },
];

const initialState = {
  message: '',
  token: '',
};

export default function NewInvitationForm({ accountId }: Props) {
  const [state, formAction] = useFormState(createInvitation, initialState);

  return (
    <form className="animate-in flex-1 flex flex-col w-full justify-center gap-y-6 text-foreground">
      {Boolean(state?.token) ? (
        <div className="text-sm">{fullInvitationUrl(state.token!)}</div>
      ) : (
        <>
          <input type="hidden" name="accountId" value={accountId} />
          <div className="flex flex-col gap-y-2">
            <Label htmlFor="invitationType">Invitation Type</Label>
            <Select defaultValue="one_time" name="invitationType">
              <SelectTrigger>
                <SelectValue placeholder="Invitation type" />
              </SelectTrigger>
              <SelectContent>
                {invitationOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-y-2">
            <Label htmlFor="accountRole">Team Role</Label>
            <Select defaultValue="member" name="accountRole">
              <SelectTrigger>
                <SelectValue placeholder="Member type" />
              </SelectTrigger>
              <SelectContent>
                {memberOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <SubmitButton
            formAction={async (prevState: any, formData: FormData) =>
              formAction(formData)
            }
            errorMessage={state?.message}
            pendingText="Creating..."
          >
            Create invitation
          </SubmitButton>
        </>
      )}
    </form>
  );
}
