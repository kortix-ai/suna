const subscriptionKeysBase = ['subscription'] as const;
const modelKeysBase = ['models'] as const;
const usageKeysBase = ['usage'] as const;

export const subscriptionKeys = {
  all: subscriptionKeysBase,
  details: () => [...subscriptionKeysBase, 'details'] as const,
  commitment: (subscriptionId: string) => [...subscriptionKeysBase, 'commitment', subscriptionId] as const,
} as const;

export const modelKeys = {
  all: modelKeysBase,
  available: ['models', 'available'] as const,
} as const;

export const usageKeys = {
  all: usageKeysBase,
  logs: (page?: number, itemsPerPage?: number) => [...usageKeysBase, 'logs', { page, itemsPerPage }] as const,
} as const;