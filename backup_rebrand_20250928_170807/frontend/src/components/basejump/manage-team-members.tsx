import { createClient } from '@/lib/supabase/server';
import { Table, TableRow, TableBody, TableCell } from '../ui/table';
import { Badge } from '../ui/badge';
import TeamMemberOptions from './team-member-options';

type Props = {
  accountId: string;
};

export default async function ManageTeamMembers({ accountId }: Props) {
  const supabaseClient = await createClient();

  const { data: members } = await supabaseClient.rpc('get_account_members', {
    account_id: accountId,
  });

  const { data } = await supabaseClient.auth.getUser();
  const isPrimaryOwner = members?.find(
    (member: any) => member.user_id === data?.user?.id,
  )?.is_primary_owner;

  return (
    <div>
      <Table>
        <TableBody>
          {members?.map((member: any) => (
            <TableRow
              key={member.user_id}
              className="hover:bg-hover-bg border-subtle dark:border-white/10"
            >
              <TableCell>
                <div className="flex items-center gap-x-2">
                  <span className="font-medium text-card-title">
                    {member.name}
                  </span>
                  <Badge
                    variant={
                      member.account_role === 'owner' ? 'default' : 'outline'
                    }
                    className={
                      member.account_role === 'owner'
                        ? 'bg-primary hover:bg-primary/90'
                        : 'text-foreground/70 border-subtle dark:border-white/10'
                    }
                  >
                    {member.is_primary_owner
                      ? 'Primary Owner'
                      : member.account_role}
                  </Badge>
                </div>
              </TableCell>
              <TableCell>
                <span className="text-sm text-foreground/70">
                  {member.email}
                </span>
              </TableCell>
              <TableCell className="text-right">
                {!Boolean(member.is_primary_owner) && (
                  <TeamMemberOptions
                    teamMember={member}
                    accountId={accountId}
                    isPrimaryOwner={isPrimaryOwner}
                  />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
