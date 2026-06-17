import { randomUUID } from 'node:crypto';

export type Factory<T> = (overrides?: Partial<T>) => T;

let sequence = 0;

export function nextSequence(): number {
  sequence += 1;
  return sequence;
}

export function resetSequence(): void {
  sequence = 0;
}

export function defineFactory<T>(build: (index: number) => T): Factory<T> {
  return (overrides = {}) => ({ ...build(nextSequence()), ...overrides });
}

export interface User {
  id: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
  createdAt: string;
}

export interface Project {
  id: string;
  ownerId: string;
  slug: string;
  name: string;
  archived: boolean;
  createdAt: string;
}

export const userFactory = defineFactory<User>((index) => ({
  id: randomUUID(),
  email: `user${index}@example.test`,
  name: `User ${index}`,
  isPlatformAdmin: false,
  createdAt: new Date(0).toISOString(),
}));

export const projectFactory = defineFactory<Project>((index) => ({
  id: randomUUID(),
  ownerId: randomUUID(),
  slug: `project-${index}`,
  name: `Project ${index}`,
  archived: false,
  createdAt: new Date(0).toISOString(),
}));

export function buildMany<T>(factory: Factory<T>, count: number, overrides?: Partial<T>): T[] {
  return Array.from({ length: count }, () => factory(overrides));
}
