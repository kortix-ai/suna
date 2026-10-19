import { useUiViewerId } from '@kortix/ui/providers/ui-provider';
import { ADMIN_ROLE_QUERY_KEY, useAdminRole as useSdkAdminRole } from '@kortix/sdk/react';
import type { UseQueryOptions } from '@tanstack/react-query';
import type { AdminRole } from '@kortix/sdk';

// The query lives in `@kortix/sdk/react`. Only the signed-in user's id is
// web's: it comes from the auth provider.
export { ADMIN_ROLE_QUERY_KEY };

export const useAdminRole = (options?: Partial<UseQueryOptions<AdminRole>>) =>
  useSdkAdminRole(useUiViewerId(), options);
