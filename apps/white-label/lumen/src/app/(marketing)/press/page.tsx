import { BrandGlyph, BrandMark, GLYPH_L, GLYPH_LAMP, Wordmark } from '@/components/brand-mark';
import { Container, Lead, Section } from '@/components/marketing/parts';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Brand', description: 'The Lumen wordmark, glyph, colours, type and pattern.' };

const COLOURS = [
  ['Ink blue', '#10233A', 'Bands, the primary action, the send button', 'bg-navy text-white'],
  ['Paper', '#F5F3EF', 'Media cards, alternate bands', 'bg-[#F5F3EF] text-[#141414]'],
  ['White', '#FFFFFF', 'The page', 'bg-white text-[#141414] border border-[#E6E3DE]'],
  ['Ink', '#141414', 'Headlines and links', 'bg-[#141414] text-white'],
  ['Grey', '#6B6964', 'Body copy, never black', 'bg-[#6B6964] text-white'],
  ['Lamp', '#C89B4A', 'One element per view, earned', 'bg-[#C89B4A] text-[#141414]'],
] as const;

export default function PressPage() {
  return (
    <>
      <section className="pattern-laid">
        <Container className="grid gap-10 py-20 text-white md:grid-cols-2 md:py-28">
          <div className="grid aspect-square place-items-center rounded-[4px] border border-white/15">
            <BrandMark className="text-[clamp(2.5rem,6vw,5rem)] text-white" />
          </div>
          <div className="flex flex-col justify-center">
            <h1 className="display-lg">Lumen brand guidelines</h1>
            <p className="mt-6 max-w-md text-[18px] leading-[1.4] text-white/70">The wordmark, the glyph, the colours, the type and the weave, and how to use them.</p>
            <div className="mt-10 flex flex-wrap gap-3">
              <a href="/brand/lumen-lockup.svg" download className="inline-flex h-10 items-center rounded-full bg-white px-5 text-[15px] font-medium text-navy">
                Download lockup (SVG)
              </a>
              <a href="/brand/lumen-glyph.svg" download className="inline-flex h-10 items-center rounded-full bg-white/10 px-5 text-[15px] font-medium text-white">
                Download glyph (SVG)
              </a>
            </div>
          </div>
        </Container>
      </section>

      <Section rule={false}>
        <Container className="grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <h2 className="display-sm">Wordmark</h2>
            <Lead className="mt-6 text-[17px]!">
              LUMEN in capitals, set in the display serif and spaced tight and even. The wordmark is the logo. Never stretch it, outline it or set it
              in another face.
            </Lead>
          </div>
          <div
            className="relative grid aspect-[16/9] place-items-center rounded-[4px] bg-paper lg:col-span-8"
            style={{ backgroundImage: 'linear-gradient(var(--hairline) 1px, transparent 1px), linear-gradient(90deg, var(--hairline) 1px, transparent 1px)', backgroundSize: '32px 32px' }}
          >
            <Wordmark className="text-[clamp(3rem,9vw,8rem)]" />
          </div>
        </Container>
      </Section>

      <Section>
        <Container className="grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <h2 className="display-sm">Glyph</h2>
            <Lead className="mt-6 text-[17px]!">
              A bracketed serif L with a lit window in its corner. Lumen is a unit of light; the window is the one warm note in the system. The glyph
              stands alone only where the wordmark cannot fit: the favicon, the app icon, an avatar.
            </Lead>
          </div>
          <div className="grid gap-3 sm:grid-cols-3 lg:col-span-8">
            <div className="grid aspect-square place-items-center rounded-[4px] bg-paper">
              <svg viewBox="0 0 24 24" className="size-3/5" aria-label="Glyph construction">
                {Array.from({ length: 25 }, (_, i) => (
                  <g key={i}>
                    <line x1={i} y1="0" x2={i} y2="24" stroke="var(--hairline)" strokeWidth="0.05" />
                    <line x1="0" y1={i} x2="24" y2={i} stroke="var(--hairline)" strokeWidth="0.05" />
                  </g>
                ))}
                <BrandGlyphPaths />
              </svg>
            </div>
            <div className="grid aspect-square place-items-center rounded-[4px] bg-navy">
              <BrandGlyph className="size-2/5 text-[#F5F3EF]" />
            </div>
            <div className="grid aspect-square place-items-center rounded-[4px] border border-border bg-white">
              <BrandGlyph className="size-2/5 text-[#141414]" lit={false} />
            </div>
          </div>
        </Container>
      </Section>

      <Section>
        <Container>
          <h2 className="display-sm">Colour</h2>
          <p className="mt-6 max-w-lg text-[17px] text-muted-foreground">
            White and paper carry the page. Ink blue is a surface, used whole: never as a tint or a gradient on UI. The lamp is earned.
          </p>
          <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {COLOURS.map(([n, hex, use, cls]) => (
              <div key={n} className={`flex aspect-[4/3] flex-col justify-between rounded-[4px] p-6 ${cls}`}>
                <p className="display-xs">{n}</p>
                <div className="text-[13px] opacity-80">
                  <p className="font-mono">{hex}</p>
                  <p>{use}</p>
                </div>
              </div>
            ))}
          </div>
        </Container>
      </Section>

      <Section>
        <Container className="grid gap-12 lg:grid-cols-2">
          <div>
            <h2 className="display-sm">Type</h2>
            <div className="mt-10 space-y-8">
              <div className="border-t border-hairline pt-5">
                <p className="text-[13px] text-muted-foreground">Display · Newsreader, weight 360–400, tight tracking</p>
                <p className="display-md mt-3">Every answer, cited.</p>
              </div>
              <div className="border-t border-hairline pt-5">
                <p className="text-[13px] text-muted-foreground">Interface and body · Geist 400 and 500</p>
                <p className="mt-3 text-[20px] tracking-[-0.02em]">Upload a data room and ask what changed.</p>
              </div>
              <div className="border-t border-hairline pt-5">
                <p className="text-[13px] text-muted-foreground">Data · Geist Mono</p>
                <p className="mt-3 font-mono text-[15px]">msa-brightwater-quillon.pdf · p. 2 · ¶ 11.1</p>
              </div>
            </div>
          </div>
          <div>
            <h2 className="display-sm">The weave</h2>
            <p className="mt-6 max-w-md text-[17px] text-muted-foreground">
              Laid paper: fine laid lines and wider chain lines, tone on tone. It frames product imagery on the brand surface. It never sits behind
              body copy.
            </p>
            <div className="pattern-laid mt-10 aspect-[4/3] rounded-[4px]" />
          </div>
        </Container>
      </Section>
    </>
  );
}

/** The glyph, inline, for the construction grid. */
function BrandGlyphPaths() {
  return (
    <>
      <path d={GLYPH_L} fill="currentColor" fillOpacity="0.9" />
      <rect x={GLYPH_LAMP.x} y={GLYPH_LAMP.y} width={GLYPH_LAMP.size} height={GLYPH_LAMP.size} rx={GLYPH_LAMP.r} className="fill-lamp" />
    </>
  );
}
