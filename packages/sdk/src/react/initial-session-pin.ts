interface SessionPinSources {
  startPin?: string | null;
  initialPin?: string | null;
  persistedPin?: string | null;
}

export function resolveSessionPin({
  startPin,
  initialPin,
  persistedPin,
}: SessionPinSources): string | null {
  return startPin ?? initialPin ?? persistedPin ?? null;
}
