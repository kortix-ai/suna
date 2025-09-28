import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../ui/card';
import { createClient } from '@/lib/supabase/server';
import { Table, TableRow, TableBody, TableCell } from '../ui/table';
import { Button } from '../ui/button';
import Link from 'next/link';
import { Badge } from '../ui/badge';

export default async function ManageTeams() {
  const supabaseClient = await createClient();

  const { data } = await supabaseClient.rpc('get_accounts');

  const teams: any[] = data?.filter(
    (team: any) => team.personal_account === false,
  );

  return (
    <Card className="border-subtle dark:border-white/10 bg-white dark:bg-background-secondary shadow-none rounded-xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-base text-card-title">Your Teams</CardTitle>
        <CardDescription className="text-foreground/70">
          Teams you belong to or own
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableBody>
            {teams.map((team) => (
              <TableRow
                key={team.account_id}
                className="hover:bg-hover-bg border-subtle dark:border-white/10"
              >
                <TableCell>
                  <div className="flex items-center gap-x-2">
                    <span className="font-medium text-card-title">
                      {team.name}
                    </span>
                    <Badge
                      variant={
                        team.account_role === 'owner' ? 'default' : 'outline'
                      }
                      className={
                        team.account_role === 'owner'
                          ? 'bg-primary hover:bg-primary/90'
                          : 'text-foreground/70 border-subtle dark:border-white/10'
                      }
                    >
                      {team.is_primary_owner
                        ? 'Primary Owner'
                        : team.account_role}
                    </Badge>
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    asChild
                    className="rounded-lg h-9 border-subtle dark:border-white/10 hover:bg-hover-bg dark:hover:bg-hover-bg-dark"
                  >
                    <Link href={`/${team.slug}`}>View</Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
