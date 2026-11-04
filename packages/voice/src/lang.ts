// Languages. The call speaks whatever the user speaks: speech-to-text detects it, the agent answers in it,
// and the fixed phrases (disclosure, acknowledgments, progress) come from a phrasebook in that language:
// English and Serbo-Croatian are written here; any other language is translated once, on first use.
import { chargeReply } from './cost'
import { fastFetch, viaModels } from './models'

export type Book = {
  acks: string[] // to a question
  sure: string[] // to a request ("can you…", "check…")
  sorry: string[] // to trouble ("it's broken", "doesn't work")
  listen: string[] // soft backchannels while the user is still talking: "go on"
  bye: string // to thanks and goodbyes, at once, without the agent
  welcome: string // to thanks alone
  lookup: string // the acknowledgment while a web search runs: says what is happening
  check: string // the same while the workspace is searched
  moment: string // nothing informative yet at 3 s
  noted: string // words queued while the agent works
  long: string // once, at 30 s of work
  wait: string // after "hold on"
  go: string // after "okay, I'm back"
  failed: string
  still: string // progress with nothing new to report; "{n}" (optional) is the number of steps so far
  disclosure: string
  doing: Record<string, string>
}

const en: Book = {
  // Never "Let me…" (the agent's lead-in starts that way); "Right, okay." was judged filler in English and German.
  // The first sound fits what was said (Sesame: listeners prefer humans only given context; the same waveform
  // every turn sounds monotone, Kawahara 2016). "Hmm, okay." before a trivial answer was judged stalling.
  acks: ['Okay.', 'Yeah.'], // no "Right."/"Alright." (judged empty), no "Hmm." ("it uses hmm too much"), no "Oh," (news only)
  sure: ['Sure.', 'On it.', 'Okay.'],
  sorry: ['Oh no.', 'Ah, okay.', 'Hm, okay.'],
  // Continuers rise (over 60% of "mm-hm"/"uh-huh", Ward 2019): a comma ending makes the voice continue, a period
  // concludes (one commercial TTS: 20% → 100% heard as still talking with a trailing comma or "um,", 2023).
  listen: ['Mm-hm,', 'Uh-huh,', 'Mm-hm,', 'Right,'], // no "Yeah," ("a lot of yeah", a live call)
  bye: 'Anytime. Bye!',
  welcome: 'Sure thing.',
  lookup: 'Let me look that up.',
  check: 'Let me check.',
  moment: 'One moment.',
  noted: 'Got it.',
  long: "This is taking a while. I'll tell you when it's done.",
  wait: 'Sure, take your time.',
  go: 'Go ahead.',
  failed: 'Sorry, something went wrong on my side. Want me to try again?',
  still: 'Still on it.', // a step count is activity, not news ("Still working. 1 steps so far." in a simulated call)
  disclosure: "Hi, I'm {name}, an AI voice assistant. How can I help?",
  doing: {
    bash: 'Let me run that.',
    read: 'Let me look at that file.',
    glob: 'Let me look through the files.',
    list: 'Let me look through the files.',
    grep: 'Let me search the code.',
    edit: 'Let me make that change.',
    patch: 'Let me make that change.',
    write: 'Let me write that.',
    webfetch: 'Let me read that page.',
    scrape_webpage: 'Let me read that page.',
    websearch: 'Let me search the web.',
    web_search: 'Let me search the web.',
    task: "I'll put a helper on it.",
    todowrite: 'Let me plan this out.',
  },
}

// Serbian, Croatian and Bosnian share one Latin-script book: every TTS we have reads Cyrillic Serbian with
// Russian pronunciation ("помоћи" → "помочь", measured with xAI and Gemini), Latin correctly.
const sh: Book = {
  acks: ['Dobro.', 'Aha, dobro.', 'Aha.'], // "Može." answers a request, not a question (judged a non-sequitur)
  sure: ['Može.', 'Važi.', 'Dobro.'],
  sorry: ['Uh.', 'Aha, dobro.', 'Hm, dobro.'],
  listen: ['Aha,', 'Da,', 'Mhm,', 'Da,'],
  bye: 'Nema na čemu. Ćao!',
  welcome: 'Nema na čemu.',
  lookup: 'Samo da pogledam.',
  check: 'Samo da proverim.',
  moment: 'Evo, samo sekund.', // "Dobro, samo trenutak." was judged stiff
  noted: 'Važi.',
  long: 'Ovo traje malo duže. Javiću kad završim.',
  wait: 'Naravno, polako.',
  go: 'Izvoli.',
  failed: 'Izvini, nešto nije uspelo kod mene. Da probam ponovo?',
  still: 'Još radim na tome.',
  disclosure: 'Zdravo, ja sam {name}, glasovni asistent sa veštačkom inteligencijom. Kako mogu da pomognem?',
  doing: {
    bash: 'Da to pokrenem.',
    read: 'Da pogledam taj fajl.',
    glob: 'Da pogledam fajlove.',
    list: 'Da pogledam fajlove.',
    grep: 'Da pretražim kod.',
    edit: 'Da to izmenim.',
    patch: 'Da to izmenim.',
    write: 'Da to napišem.',
    webfetch: 'Da pročitam stranicu.',
    scrape_webpage: 'Da pročitam stranicu.',
    websearch: 'Da potražim na internetu.',
    web_search: 'Da potražim na internetu.',
    task: 'Daću to pomoćniku.',
    todowrite: 'Da isplaniram korake.',
  },
}

const SH = new Set(['sr', 'hr', 'bs', 'sh', 'cnr'])
export const family = (lang: string) => (SH.has(lang) ? 'sh' : lang)
const books: Record<string, Book | Promise<Book | undefined>> = { en, sh }

/** The phrasebook for a language; until a new language is translated, undefined (stay quiet, never wrong-language). */
export function book(lang: string): Book | undefined {
  const k = family(lang)
  const b = (books[k] ??= translate(k).then((t) => (t ? (books[k] = t) : (delete books[k], undefined))))
  return b instanceof Promise ? undefined : b
}

// The AI disclosure is legal text (EU AI Act Art. 50): written here for the commonest languages rather than
// machine-translated at call start, which also took longer than the greeting can wait (a German caller was
// greeted in English in a simulated call). Native review before launch.
const DISCLOSURES: Record<string, string> = {
  de: 'Hallo, ich bin {name}, ein KI-Sprachassistent. Wie kann ich helfen?',
  fr: 'Bonjour, je suis {name}, un assistant vocal IA. Comment puis-je vous aider ?',
  es: 'Hola, soy {name}, un asistente de voz con IA. ¿En qué puedo ayudarte?',
  it: 'Ciao, sono {name}, un assistente vocale IA. Come posso aiutarti?',
  pt: 'Olá, sou {name}, um assistente de voz com IA. Como posso ajudar?',
}
/** The AI disclosure in a language: written, translated, or English. */
export const disclose = (lang: string) => DISCLOSURES[family(lang)] ?? book(lang)?.disclosure

/** The phrasebook, waiting up to `ms` for a new language's translation (a call's first words). */
export async function bookSoon(lang: string, ms = 1500): Promise<Book | undefined> {
  const b = (book(lang), books[family(lang)])
  return b instanceof Promise ? Promise.race([b, Bun.sleep(ms).then(() => undefined)]) : b
}

// One small model call per new language, through the same gateway the agent uses.
async function translate(lang: string): Promise<Book | undefined> {
  const base = process.env.VOICE_LLM_URL ?? process.env.KORTIX_LLM_BASE_URL ?? 'https://openrouter.ai/api/v1'
  const key = process.env.VOICE_LLM_KEY ?? process.env.OPENROUTER_API_KEY ?? process.env.KORTIX_TOKEN
  const init: RequestInit = {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.VOICE_LLM_MODEL ?? 'google/gemini-3.5-flash-lite',
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: `Translate every string value of this JSON into the language with code "${lang}", as a person would say it on a phone call; keep keys and the {n} placeholder; reply with JSON only.\n${JSON.stringify(en)}` }],
    }),
  }
  // In a Kortix box the models base serves the model (its id without the org prefix); elsewhere the agent's gateway.
  const res = await (viaModels() ? fastFetch(init) : fetch(`${base}/chat/completions`, init)).catch(() => undefined)
  try {
    const j = (await res!.json()) as { choices: { message: { content: string } }[] }
    chargeReply('lang', process.env.VOICE_LLM_MODEL ?? 'google/gemini-3.5-flash-lite', j)
    const out = JSON.parse(j.choices[0]!.message.content) as Book
    return out.acks?.length && out.doing ? { ...out, disclosure: DISCLOSURES[lang] ?? out.disclosure } : undefined
  } catch {
    return undefined
  }
}

// ISO 639-1 codes by English name, for Whisper's detected-language names ("serbian" → "sr").
const names = new Intl.DisplayNames(['en'], { type: 'language' })
const CODES = 'en es fr de it pt nl sv no da fi pl cs sk sl hr sr bs mk bg ru uk be el tr ar he fa hi ur bn ta te ml mr th vi id ms tl zh ja ko ro hu lt lv et ca gl eu cy ga is sq ka hy az kk uz sw af'
export const ISO: Record<string, string> = Object.fromEntries(CODES.split(' ').map((c) => [names.of(c)!.toLowerCase(), c]))

// Serbian Cyrillic → Latin (Gaj's alphabet, one to one).
const CYR = 'а:a б:b в:v г:g д:d ђ:đ е:e ж:ž з:z и:i ј:j к:k л:l љ:lj м:m н:n њ:nj о:o п:p р:r с:s т:t ћ:ć у:u ф:f х:h ц:c ч:č џ:dž ш:š'
const LAT: Record<string, string> = Object.fromEntries(CYR.split(' ').flatMap((p) => {
  const [c, l] = p.split(':') as [string, string]
  return [[c, l], [c.toUpperCase(), l[0]!.toUpperCase() + l.slice(1)]]
}))
export const latin = (s: string) => s.replace(/[Ѐ-ӿ]/g, (c) => LAT[c] ?? c)
/** Serbian (or Macedonian) Cyrillic in Latin, for TTS; Russian, Ukrainian and Bulgarian have letters Serbian lacks and stay. */
export const serbianLatin = (s: string) => (/[Ѐ-ӿ]/.test(s) && !/[яюыэъьёйщєіїЯЮЫЭЪЬЁЙЩЄІЇ]/.test(s) ? latin(s) : s)

/** Text as the turn rules match it: lowercase, Serbian Latin, no diacritics. */
export const norm = (s: string) => latin(s.toLowerCase()).replace(/đ/g, 'dj').normalize('NFD').replace(/\p{M}/gu, '')
