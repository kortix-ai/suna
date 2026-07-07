import type { KortixAccount } from '@kortix/sdk/projects-client';

export interface CreateAccountSelection {
  /** Accounts the user may create projects in (owner/admin), sorted by name. */
  options: KortixAccount[];
  /** The account id the create/link mutations should target. */
  effectiveAccountId: string | null;
  /** The account to display as the creation target, when resolvable. */
  currentAccount: KortixAccount | null;
  /** True when there is at least one other account to switch to. */
  canSwitch: boolean;
}

/** Resolves which account a new project will be created under: an explicit
 *  in-modal pick wins (only while it remains a creatable account), otherwise
 *  the account handed in by the opener. Degrades to the plain default id when
 *  the accounts list is unavailable so the modal keeps working without it. */
export function resolveCreateAccountSelection(
  accounts: KortixAccount[] | undefined,
  defaultAccountId: string | null,
  pickedAccountId: string | null,
): CreateAccountSelection {
  const list = accounts ?? [];
  const options = list
    .filter((account) => account.account_role === 'owner' || account.account_role === 'admin')
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const picked =
    pickedAccountId && options.some((account) => account.account_id === pickedAccountId)
      ? pickedAccountId
      : null;
  const effectiveAccountId = picked ?? defaultAccountId;
  const currentAccount = list.find((account) => account.account_id === effectiveAccountId) ?? null;
  const canSwitch =
    currentAccount !== null && options.some((account) => account.account_id !== effectiveAccountId);

  return { options, effectiveAccountId, currentAccount, canSwitch };
}
