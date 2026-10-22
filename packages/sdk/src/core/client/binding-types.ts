export type DropFirst<T extends unknown[]> = T extends [unknown, ...infer R] ? R : [];
