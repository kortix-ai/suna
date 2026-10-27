/** The one place that talks to the ElevenLabs HTTP API (TTS, music, SFX, voice design, Voice Library). */
const BASE = "https://api.elevenlabs.io";

async function call(method: "GET" | "POST", path: string, body?: unknown, accept?: string): Promise<Response> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set (or use the kokoro/stub providers, or YT_OFFLINE=1)");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "xi-api-key": key, "content-type": "application/json", ...(accept ? { accept } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${path.split("?")[0]} ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return res;
}

export const elevenlabsPost = (path: string, body: unknown, accept?: string) => call("POST", path, body, accept);
export const elevenlabsGet = (path: string) => call("GET", path);
