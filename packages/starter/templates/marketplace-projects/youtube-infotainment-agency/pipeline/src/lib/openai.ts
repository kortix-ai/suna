/** The one place that talks to the OpenAI HTTP API (the image model that draws style frames). */
const BASE = "https://api.openai.com/v1";

export type ImageUsage = { input_tokens: number; output_tokens: number };

export function openaiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set: ask for it with `kortix secrets request OPENAI_API_KEY --scope runtime`");
  return key;
}

/** One image from `/images/generations`, as PNG bytes, with the tokens the API billed. */
export async function generateImage(body: { model: string; prompt: string; size: string; quality: string }): Promise<{ png: Buffer; usage: ImageUsage }> {
  const res = await fetch(`${BASE}/images/generations`, {
    method: "POST",
    headers: { authorization: `Bearer ${openaiKey()}`, "content-type": "application/json" },
    body: JSON.stringify({ ...body, n: 1 }),
  });
  if (!res.ok) throw new Error(`OpenAI images ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const json = (await res.json()) as { data?: { b64_json?: string }[]; usage?: ImageUsage };
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error(`OpenAI images returned no image: ${JSON.stringify(json).slice(0, 300)}`);
  return { png: Buffer.from(b64, "base64"), usage: json.usage ?? { input_tokens: 0, output_tokens: 0 } };
}
