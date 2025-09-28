import { createQueryKeys } from '@/hooks/use-query';

const subscriptionKeysBase = ['subscription'] as const;
const modelKeysBase = ['models'] as const;
const usageKeysBase = ['usage'] as const;

export const subscriptionKeys = createQueryKeys({
  all: subscriptionKeysBase,
  details: () => [...subscriptionKeysBase, 'details'] as const,
  commitment: (subscriptionId: string) => [...subscriptionKeysBase, 'commitment', subscriptionId] as const,
});

export const modelKeys = createQueryKeys({
  all: modelKeysBase,
  available: ['models', 'available'] as const,
});

export const usageKeys = createQueryKeys({
  all: usageKeysBase,
  logs: (page?: number, itemsPerPage?: number) => [...usageKeysBase, 'logs', { page, itemsPerPage }] as const,
});