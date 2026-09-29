export function toolRegistryCandidates(name: string): Set<string> {
  const candidates = new Set<string>();
  const add = (value?: string | null) => {
    if (!value) return;
    const cleaned = value.trim();
    if (!cleaned) return;
    candidates.add(cleaned);
    candidates.add(cleaned.toLowerCase());
  };

  add(name);
  add(name.replace(/_/g, '-'));
  add(name.replace(/-/g, '_'));

  const slashIdx = name.lastIndexOf('/');
  if (slashIdx > 0) {
    const short = name.slice(slashIdx + 1);
    add(short);
    add(short.replace(/_/g, '-'));
    add(short.replace(/-/g, '_'));
  }

  return candidates;
}

export function resolveRegisteredKey(candidates: Iterable<string>, registeredKeys: Iterable<string>): string | undefined {
  const allRegistered = Array.from(registeredKeys);
  const allCandidates = Array.from(candidates);
  for (const key of allCandidates) {
    if (allRegistered.includes(key)) return key;
  }

  for (const candidate of allCandidates) {
    for (const key of allRegistered) {
      if (
        candidate.endsWith(`/${key}`) ||
        candidate.endsWith(`-${key}`) ||
        candidate.endsWith(`_${key}`)
      ) {
        return key;
      }
    }
  }

  return undefined;
}
