import { afterEach, beforeEach, expect, test } from 'bun:test'
import { route } from './route'

// A place that is nowhere is a misheard word: on a Kortix dev box, "I don't know Unisite" (Whisper's "I don't know, you
// decide") after "What do you need it to do?" was routed to a forecast for "Unisite", which geocodes to nothing. The
// router's misheard-word check now hears it; a real place keeps its forecast, and a geocoder outage is never "nowhere".
const originalFetch = globalThis.fetch
const keys = ['GROQ_API_KEY', 'VOICE_MODELS_URL', 'VOICE_MODELS_TOKEN', 'VOICE_ROUTE_MODEL', 'VOICE_LANE_MODEL']
let saved: (string | undefined)[]
beforeEach(() => {
  saved = keys.map((k) => process.env[k])
  for (const k of keys) delete process.env[k]
  process.env.GROQ_API_KEY = 'test-only'
})
afterEach(() => {
  globalThis.fetch = originalFetch
  keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i] })
})

const chat = (content: object) => Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] })
/** A router that reads the turn as a forecast for the word they said, a geocoder, and the check model. */
function world(o: { geocode: 'none' | 'found' | 'down'; place: string }) {
  const seen = { checks: 0, geocodes: 0 }
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('geocoding-api')) {
      seen.geocodes++
      if (o.geocode === 'down') return Response.json({}, { status: 503 })
      return Response.json(o.geocode === 'found' ? { results: [{ name: o.place, country: 'Serbia', latitude: 45.3, longitude: 19.8 }] } : {})
    }
    if (url.includes('api.groq.com')) {
      const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] }
      if (body.model.includes('qwen')) { seen.checks++; return chat({ need: 'none', query: "I don't know, you decide" }) }
      const turn = body.messages.at(-1)!.content
      if (turn.includes("Turn: I don't know, you decide")) return chat({ need: 'none', query: '' })
      return chat({ need: 'web', query: `weather in ${o.place}`, card: { type: 'weather', place: o.place }, locationEvidence: o.place })
    }
    throw new Error(`unexpected provider ${url}`)
  }, { preconnect: originalFetch.preconnect })
  return seen
}
const CONTEXT = 'User: Can you write some python code?\nAgent: Yeah, I can write Python. What do you need it to do?'

test('a forecast for a place that is nowhere goes to the misheard-word check and is routed as they meant it', async () => {
  const seen = world({ geocode: 'none', place: 'Unisite' })
  const r = await route("I don't know Unisite", CONTEXT, '', 4000)
  expect(r?.need).toBe('none')
  expect(seen.checks).toBe(1)
})

test('a real place keeps its forecast, unchecked', async () => {
  const seen = world({ geocode: 'found', place: 'Novi Sad' })
  const r = await route("What's the weather in Novi Sad?", '', '', 4000)
  expect(r?.need).toBe('web')
  expect(r?.card).toEqual({ type: 'weather', place: 'Novi Sad' })
  expect(seen.checks).toBe(0)
})

test('a geocoder that is down is not "nowhere": the forecast stands', async () => {
  const seen = world({ geocode: 'down', place: 'Kragujevac' })
  const r = await route("What's the weather in Kragujevac?", '', '', 4000)
  expect(r?.need).toBe('web')
  expect(seen.checks).toBe(0)
})

test("the hand-back rule reaches the router only while the assistant's last line is a question", async () => {
  const systems: string[] = []
  globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
    systems.push(body.messages[0]!.content)
    return chat({ need: 'none', query: '' })
  }, { preconnect: originalFetch.preconnect })
  await route('You decide.', CONTEXT, '', 4000)
  await route('Sounds good.', 'User: What is twelve times eleven?\nAgent: One hundred thirty-two.', '', 4000)
  expect(systems[0]).toContain("answers the assistant's question")
  expect(systems[1]).not.toContain("answers the assistant's question")
})
