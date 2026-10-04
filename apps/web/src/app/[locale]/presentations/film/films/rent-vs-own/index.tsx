import { KortixLogo } from '@/components/ui/kortix-logo';
import { cn } from '@/lib/utils';
import { Shot, useFrame, type Cue, type FilmDef } from '../../engine/film';
import { bars, ease, interp, rise } from '../../engine/time';
import { Headline } from '../launch/parts';

/**
 * "Rent vs own" — 30 s, direction D in the positioning studio. One table builds
 * row by row on the beat: what you get when you rent an AI workforce, and what
 * you get when you own it. The left column describes the category, never a
 * named product; every right-column line is a shipped capability.
 */

const ROWS = [
  { label: 'Models', rented: "One lab's models", owned: 'Any model. Your keys.' },
  { label: 'Your context', rented: 'Inside their product', owned: 'Files in a repo you own' },
  { label: 'Code', rented: 'Closed', owned: 'Open source' },
  {
    label: 'Workforce',
    rented: 'An assistant per seat',
    owned: 'Agents with their own identities',
  },
  { label: 'Controls', rented: "The vendor's defaults", owned: 'Per-agent grants, per-tool rules' },
  { label: 'Leaving', rented: 'Start over', owned: 'git clone' },
] as const;

/** The table enters on bar 4 (8 s); row i lands every 1.5 bars inside it. */
const TABLE = bars(4);
const rowAt = (i: number) => bars(i * 1.5);

function Row({ i, f, vertical }: { i: number; f: number; vertical: boolean }) {
  const row = ROWS[i];
  const at = rowAt(i);
  const strike = interp(f, at + 14, at + 34, 0, 1, ease.inOutCubic);
  if (vertical)
    return (
      <div className="border-border grid gap-1.5 border-t py-4" style={rise(f, at, { dist: 14 })}>
        <span className="text-muted-foreground font-mono text-sm">{row.label}</span>
        <span className="text-muted-foreground relative w-fit text-2xl">
          {row.rented}
          <span
            className="bg-muted-foreground absolute top-1/2 left-0 h-px w-full origin-left"
            style={{ transform: `scaleX(${strike})` }}
          />
        </span>
        <span
          className={cn(
            'text-foreground text-3xl font-medium tracking-tight',
            row.label === 'Leaving' && 'font-mono',
          )}
          style={rise(f, at + 10, { dist: 10 })}
        >
          {row.owned}
        </span>
      </div>
    );
  return (
    <div
      className="border-border grid grid-cols-12 items-baseline gap-6 border-t py-5"
      style={rise(f, at, { dist: 14 })}
    >
      <span className="text-muted-foreground col-span-2 font-mono text-sm">{row.label}</span>
      <span className="text-muted-foreground relative col-span-4 w-fit text-3xl">
        {row.rented}
        <span
          className="bg-muted-foreground absolute top-1/2 left-0 h-px w-full origin-left"
          style={{ transform: `scaleX(${strike})` }}
        />
      </span>
      <span
        className={cn(
          'text-foreground col-span-6 text-3xl font-medium tracking-tight',
          row.label === 'Leaving' && 'font-mono',
        )}
        style={rise(f, at + 10, { dist: 10 })}
      >
        {row.owned}
      </span>
    </div>
  );
}

/**
 * The camera starts close on the first rows and pulls back as the table fills,
 * so the frame is never mostly empty while two rows are lit.
 */
function Table({ vertical = false }: { vertical?: boolean }) {
  const f = useFrame();
  const pull = interp(f, 0, rowAt(ROWS.length - 1) + 30, 0, 1, ease.inOutCubic);
  const camera = {
    transform: `scale(${(vertical ? 1.3 : 1.15) - (vertical ? 0.3 : 0.15) * pull})`,
    transformOrigin: `50% ${18 + 32 * pull}%`,
  };
  if (vertical)
    return (
      <div className="absolute inset-0 flex flex-col justify-center px-12" style={camera}>
        <div
          className="text-foreground flex items-center gap-2 pb-4 text-lg font-medium"
          style={rise(f, -20)}
        >
          <KortixLogo variant="icon" size={18} /> Rented, or owned
        </div>
        {ROWS.map((_, i) => (
          <Row key={i} i={i} f={f} vertical />
        ))}
      </div>
    );
  return (
    <div className="absolute inset-0 flex flex-col justify-center px-28" style={camera}>
      <div className="grid grid-cols-12 gap-6 pb-3" style={rise(f, -20)}>
        <span className="col-span-2" />
        <span className="text-muted-foreground col-span-4 text-base">Rented</span>
        <span className="text-foreground col-span-6 flex items-center gap-2 text-base font-medium">
          <KortixLogo variant="icon" size={16} /> Owned
        </span>
      </div>
      {ROWS.map((_, i) => (
        <Row key={i} i={i} f={f} vertical={false} />
      ))}
    </div>
  );
}

function Open() {
  const f = useFrame();
  return (
    <div className="absolute inset-0 grid place-items-center">
      {f < bars(2) + 10 ? (
        <div style={{ opacity: interp(f, bars(2) - 8, bars(2) + 6, 1, 0, ease.outQuad) }}>
          <Headline lead="You can rent" rest="your AI workforce." f={f} at={10} stack />
        </div>
      ) : null}
      {f >= bars(2) - 4 ? (
        <div className="absolute">
          <Headline lead="Or you can own it." f={f} at={bars(2)} size="text-7xl" />
        </div>
      ) : null}
    </div>
  );
}

function End() {
  const f = useFrame();
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-6">
      <Headline lead="Own your AI workforce." f={f} at={0} />
      <div style={rise(f, 30, { scale: 0.94, blur: 8 })}>
        <KortixLogo variant="brandmark" size={40} className="text-foreground" />
      </div>
      <p className="text-muted-foreground font-mono text-lg" style={rise(f, 50)}>
        kortix.com
      </p>
    </div>
  );
}

function film(vertical: boolean) {
  return function RentVsOwn() {
    return (
      <>
        <Shot from={0} dur={bars(4)} enter="cut" exit="settle">
          <Open />
        </Shot>
        <Shot from={TABLE} dur={bars(9)} enter="settle" exit="settle">
          <Table vertical={vertical} />
        </Shot>
        <Shot from={bars(13)} dur={bars(2)} enter="settle" exit="cut">
          <End />
        </Shot>
      </>
    );
  };
}

const cues: Cue[] = [
  { frame: 10, sfx: 'tick', gain: 0.5 },
  { frame: bars(2), sfx: 'impact', gain: 0.9 },
  ...ROWS.map((_, i) => ({ frame: TABLE + rowAt(i), sfx: 'tick', gain: 0.55 })),
  { frame: bars(13), sfx: 'impact', gain: 0.7 },
];

const score: FilmDef['score'] = {
  bars: 15,
  sections: [
    [0, 'intro'],
    [2, 'reveal'],
    [4, 'groove'],
    [13, 'end'],
  ],
  cycle_from: 3,
  risers: [
    [2, 2],
    [13, 1.5],
  ],
  impacts: [
    [2, 0.9],
    [13, 0.7],
  ],
};

export const rentVsOwnFilm: FilmDef = {
  slug: 'rent-vs-own',
  title: 'Kortix — rent vs own',
  description:
    'Thirty seconds: what you get when you rent an AI workforce, and what you get when you own it.',
  frames: bars(15),
  Film: film(false),
  cues,
  audio: '/film/rent-vs-own.m4a',
  score,
};

/** The same film for Reels, Shorts and TikTok: 9:16, one column. */
export const rentVsOwnVerticalFilm: FilmDef = {
  ...rentVsOwnFilm,
  slug: 'rent-vs-own-vertical',
  title: 'Kortix — rent vs own (9:16)',
  size: { w: 720, h: 1280 },
  Film: film(true),
  audio: '/film/rent-vs-own-vertical.m4a',
};
