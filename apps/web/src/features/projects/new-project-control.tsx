import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { KortixAccount } from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import { Icon } from '../icon/icon';

const NewProjectControl = ({
  viewAll,
  creatableAccounts,
  activeAccountId,
  canCreateActive,
  onPick,
  label,
  fullWidth,
  className,
}: {
  viewAll: boolean;
  creatableAccounts: KortixAccount[];
  activeAccountId: string | null;
  canCreateActive: boolean;
  onPick: (accountId: string) => void;
  label: string;
  fullWidth?: boolean;
  className?: string;
}) => {
  const classes = cn(fullWidth && 'w-full', className);

  if (!viewAll) {
    return (
      <Button
        onClick={() => activeAccountId && onPick(activeAccountId)}
        disabled={!activeAccountId || !canCreateActive}
        className={classes}
      >
        <Icon.Plus />
        {label}
      </Button>
    );
  }

  if (creatableAccounts.length === 0) {
    return (
      <Button disabled className={classes}>
        <Icon.Plus />
        {label}
      </Button>
    );
  }

  if (creatableAccounts.length === 1) {
    const only = creatableAccounts[0];
    return (
      <Button onClick={() => onPick(only.account_id)} className={classes}>
        <Icon.Plus />
        {label}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className={classes}>
          <Icon.Plus />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-muted-foreground">Create in</DropdownMenuLabel>
        {creatableAccounts.map((account) => (
          <DropdownMenuItem
            key={account.account_id}
            onSelect={() => onPick(account.account_id)}
            className="flex items-center gap-2.5"
          >
            <EntityAvatar label={account.name || 'Account'} size="xs" />
            <span className="min-w-0 flex-1 truncate text-sm">{account.name || 'Account'}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default NewProjectControl;
