import { createTranslator } from 'next-intl';
import { getTranslations as getNextTranslations } from 'next-intl/server';

import messages from '../../translations/en.json';

export * from 'next-intl/server';

/** Uses request-scoped messages and keeps isolated server-action tests deterministic. */
export const getTranslations: typeof getNextTranslations = (async (...args: unknown[]) => {
  try {
    return await (getNextTranslations as (...values: unknown[]) => Promise<unknown>)(...args);
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') throw error;
    const namespace = typeof args[0] === 'string' ? args[0] : undefined;
    return createTranslator({
      locale: 'en',
      messages,
      namespace: namespace as never,
    });
  }
}) as typeof getNextTranslations;
