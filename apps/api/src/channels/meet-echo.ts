const ECHO_TTL_MS = 25_000;
const MAX_TRACKED_BOTS = 512;

const recent = new Map<string, Array<{ text: string; at: number }>>();

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function recordBotSpeech(botId: string, text: string): void {
  const norm = normalize(text);
  if (!botId || !norm) return;
  const now = Date.now();
  const list = (recent.get(botId) ?? []).filter((e) => now - e.at < ECHO_TTL_MS);
  list.push({ text: norm, at: now });
  recent.set(botId, list);
  if (recent.size > MAX_TRACKED_BOTS) prune(now);
}

export function isBotEcho(botId: string, text: string): boolean {
  const heard = normalize(text);
  if (!botId || !heard) return false;
  const now = Date.now();
  const list = (recent.get(botId) ?? []).filter((e) => now - e.at < ECHO_TTL_MS);
  return list.some((e) => echoMatch(e.text, heard));
}

function echoMatch(spoken: string, heard: string): boolean {
  if (spoken === heard) return true;
  const spokenWords = spoken.split(' ').filter(Boolean);
  const heardWords = heard.split(' ').filter(Boolean);
  if (spokenWords.length < 4) return false;
  if (heard.includes(spoken) || spoken.includes(heard)) return true;
  if (heardWords.length < 4) return false;
  const spokenSet = new Set(spokenWords);
  const uniqueHeard = new Set(heardWords);
  let covered = 0;
  for (const w of uniqueHeard) if (spokenSet.has(w)) covered++;
  return covered / uniqueHeard.size >= 0.7;
}

function prune(now: number): void {
  for (const [id, list] of recent) {
    const live = list.filter((e) => now - e.at < ECHO_TTL_MS);
    if (live.length === 0) recent.delete(id);
    else recent.set(id, live);
  }
}
