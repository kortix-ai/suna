// What is on a shared screen, for an assistant that cannot see it. The caller's client (a shared screen) or the Meet
// bridge (the meeting's presentation) sends a frame only when the picture changed, at most every few seconds. Here a
// local OCR reads its text first (tesseract when installed: ~150 ms, free), and only a frame whose text changed goes
// to a vision model (Gemini 3.5 Flash-Lite: ~1.3 s, off the reply path), which says what it is and transcribes what
// matters, numbers exact. Measured on four screens (a slide, code with an error, a table, a chart; 23 exact strings):
// Gemini 3.5 Flash-Lite missed none, 3.1 Flash-Lite missed 2, tesseract alone missed 2 (chart labels) and cannot say
// what it is looking at. VOICE_VISION=0: off; VOICE_VISION_MODEL: another Gemini model.
import { chargeReply } from './cost'
import { fastFetch, viaModels } from './models'
const MODEL = process.env.VOICE_VISION_MODEL ?? 'gemini-3.5-flash-lite'

export const visionOn = () => process.env.VOICE_VISION !== '0' && (viaModels() || !!process.env.GEMINI_API_KEY)

let tesseract: string | null | undefined
/** The frame's text by local OCR, or undefined when no OCR is installed (then every changed frame is looked at). */
export async function ocr(jpeg: Uint8Array): Promise<string | undefined> {
  if (tesseract === undefined) tesseract = Bun.which('tesseract')
  if (!tesseract) return undefined
  try {
    const p = Bun.spawn([tesseract, 'stdin', 'stdout', '--psm', '3'], { stdin: jpeg, stdout: 'pipe', stderr: 'ignore' })
    const timer = setTimeout(() => p.kill(), 3000)
    const text = await new Response(p.stdout).text()
    clearTimeout(timer)
    return (await p.exited) === 0 ? text.replace(/\s+/g, ' ').trim() : undefined
  } catch {
    return undefined
  }
}

const bag = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.,%:'-]*/gu) ?? [])
/** Whether two OCR readings are a different screen: under 80% of their words shared (a cursor or clock is not). */
export function changed(a: string, b: string) {
  const x = bag(a), y = bag(b)
  if (!x.size || !y.size) return x.size !== y.size
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return both / Math.max(x.size, y.size) < 0.8
}

/** The vision model on one frame: what it is and the text that matters; '' for people on camera or nothing readable.
 * kind 'camera': what the caller's camera shows (who and what is in view, what they hold or do), never ''. */
export async function see(jpeg: Uint8Array, lang: string, signal?: AbortSignal, kind: 'screen' | 'camera' = 'screen'): Promise<string> {
  if (kind === 'camera') return ask([jpeg], `This is what the caller's camera shows right now, in a call with a voice assistant that cannot see it. Say what is in view for it: the person (what they look like, what they are doing or holding, their expression), the place and notable objects, and any readable text exact. Plain text, no markdown, at most 60 words, in ${lang}.`, signal, 'camera')
  return ask([jpeg], `This is what someone is sharing on their screen in a call. Transcribe it for a voice assistant that cannot see it: one short line saying what it is (a slide, code, a spreadsheet, a chart, a web page...), then the text that matters, numbers, names and errors exact. Plain text, no markdown, at most 90 words, in the language shown on the screen (the call is in ${lang}). If it shows only people on camera or nothing readable, reply with exactly: (nothing)`, signal, 'screen')
}

// One call to the vision model with frames and an instruction; '' on failure or when it saw nothing to say.
async function ask(jpegs: Uint8Array[], instruction: string, signal?: AbortSignal, use = 'look'): Promise<string> {
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000)
  const data = (j: Uint8Array) => Buffer.from(j).toString('base64')
  try {
    // In a Kortix box the same model, through its models base, as a chat with image parts.
    if (viaModels()) {
      const res = await fastFetch({
        method: 'POST',
        signal: deadline,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL, temperature: 0, max_tokens: 300, reasoning_effort: 'minimal',
          messages: [{ role: 'user', content: [{ type: 'text', text: instruction }, ...jpegs.map((j) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data(j)}` } }))] }],
        }),
      })
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      chargeReply('vision', MODEL, j, jpegs.length > 1 ? `${use}, ${jpegs.length} frames` : use)
      const text = (j.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').trim()
      return /^\(?nothing\)?\.?$/i.test(text) ? '' : text
    }
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      signal: deadline,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '' },
      //codeql[js/file-access-to-http] Non-exploit, by design: the call's own screenshots go to the call's configured Gemini key at the fixed https://generativelanguage.googleapis.com host; nothing in the image or text chooses the request target.
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: instruction }, ...jpegs.map((j) => ({ inlineData: { mimeType: 'image/jpeg', data: data(j) } }))] }],
        generationConfig: { temperature: 0, maxOutputTokens: 300, thinkingConfig: { thinkingLevel: 'minimal' } },
      }),
    })
    const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
    chargeReply('vision', MODEL, j, jpegs.length > 1 ? `${use}, ${jpegs.length} frames` : use)
    const text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').replace(/\s+/g, ' ').trim()
    return /^\(?nothing\)?\.?$/i.test(text) ? '' : text
  } catch {
    return ''
  }
}

/** A question about what they show, answered from the newest frames themselves (their screen, their camera): the
 * standing reading of a frame is general, and "what's the error on line 12?" needs the frame looked at for it.
 * A question about the assistant itself is (nothing): "Klaudia, what are you watching for?" (VISUAL: "watching") was
 * looked at, the look described the slide, and she answered "The Serbia launch on Nov 14." instead of her watch for
 * the roadmap (meeting meta e2e, 2026-11-02). */
export function look(frames: { jpeg: Uint8Array; from: string }[], question: string, lang: string, signal?: AbortSignal): Promise<string> {
  const what = frames.map((f, i) => `image ${i + 1}: ${f.from === 'camera' ? "the caller's camera" : f.from === 'the presentation' ? 'the presentation shared in the meeting' : 'their shared screen'}`).join('; ')
  return ask(frames.map((f) => f.jpeg), `A voice assistant on a call is being asked, about what the caller shows it (${what}): "${question}". Answer for it from the images: the specific thing asked, with any text, numbers, names or errors exact, plus one line on what is shown if that helps. Plain text, no markdown, at most 70 words, in ${lang}. If the images do not show it, say what they do show instead. If the question is not about what is shown at all but about the assistant itself (what it was asked to do, to remind them of, or to watch for), reply with exactly (nothing).`, signal)
}

// A question about what they show ("can you see my screen?", "what's this error?", "what am I holding?"), in English
// or Serbian: looked at with the frames, not answered from words alone.
export const VISUAL = /\b(see|seeing|seen|look(ing)? at|watch(ing)?|screen|screens|camera|cam|webcam|display(ed)?|show(ing|n)?|monitor|on (my|the|this) (screen|page|slide|tab|window)|what('?s| is) (this|that|on|here)|read (this|that|it|what)|in front of|holding|wearing|vidi(š|s)?|vidiš li|ekran|kamer\w*|pogledaj|šta (je|ima) (ovo|to|na)|sta je ovo)\b/i
