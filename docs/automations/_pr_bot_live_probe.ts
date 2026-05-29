// Probe file for the PR-bot live test.
// Deliberately contains a pointless identity wrapper for the thermo review to flag.
export function identity<T>(x: T): T {
  return x;
}
export function getName(u: { name: string }): string {
  return identity(u.name);
}
