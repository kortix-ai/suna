import {
  useMutation,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { retiredEndpointError } from '../core/http/api/errors';

/**
 * Building blocks for hooks whose route the API removed. The hooks stay
 * exported until the next major so no import breaks. Each one fails at once
 * with `ENDPOINT_RETIRED`, sends no request, and never retries or polls.
 * Not exported from `@kortix/sdk/react`.
 */
export function useRetiredQuery<T>(
  name: string,
  queryKey: readonly unknown[],
  enabled = true,
): UseQueryResult<T, Error> {
  return useQuery<T, Error>({
    queryKey,
    queryFn: () => Promise.reject(retiredEndpointError(name)),
    enabled,
    retry: false,
  });
}

export function useRetiredMutation<TData = unknown, TVariables = void>(
  name: string,
): UseMutationResult<TData, Error, TVariables> {
  return useMutation<TData, Error, TVariables>({
    mutationFn: () => Promise.reject(retiredEndpointError(name)),
  });
}
