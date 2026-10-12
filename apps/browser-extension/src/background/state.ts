import type { Stored } from './types';

export const getStored = async (): Promise<Stored> => (await chrome.storage.local.get(null)) as Stored;
export const setStored = (patch: Partial<Stored>) => chrome.storage.local.set(patch);
export const clearStored = (keys: (keyof Stored)[]) => chrome.storage.local.remove(keys);

export const wsUrl = (apiUrl: string, path: string) =>
  `${apiUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}${path}`;
