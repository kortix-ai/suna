import { Badge } from '@/components/ui/badge';
import { KortixLogo } from '@/components/ui/kortix-logo';
import { IconFrame } from '@/components/ui/marketing/icon-frame';
import { Shot, useFrame, type Cue, type FilmDef } from '../../engine/film';
import { bars, ease, fall, interp, rise, stagger } from '../../engine/time';
import { Headline, Screen, Words } from '../launch/parts';

/**
 * "Sovereign" — 60 s, direction A in the positioning studio: own your AI
 * workforce, down to the last permission. One spine: an agent goes from no
 * access to exactly the access it needs, inside a company you own. Every
 * product beat is a capture of the real web app (synthetic Northwind
 * workspace), served from public/media/film.
 *
 * Truth rules (proof map, 2026-09-29): tool rules are opt-in ("decide", never
 * "it asks"); groups and the audit log are Enterprise and say so on screen;
 * "your servers" means self-hosting the platform — never "air-gapped".
 */

const M = '/media/film';

/** A product beat: two-tone line on top, the real screen under it. */
function Beat({
  lead,
  rest,
  children,
  chip,
}: {
  lead: string;
  rest?: string;
  children: (f: number) => React.ReactNode;
  chip?: string;
}) {
  const f = useFrame();
  return (
    <div className="absolute inset-0 flex flex-col items-center gap-7 pt-12">
      <div className="flex items-center gap-3 text-center">
        <Headline lead={lead} rest={rest} f={f} at={-6} size="text-4xl" />
        {chip ? (
          <span style={rise(f, 30, { dist: 0, scale: 0.9 })}>
            <Badge variant="outline" size="sm">
              {chip}
            </Badge>
          </span>
        ) : null}
      </div>
      <div style={{ ...rise(f, 4, { dist: 40, scale: 0.97 }), perspective: 1600 }}>
        <div style={{ transform: `rotateX(${interp(f, 0, 120, 7, 0, ease.outCubic)}deg)` }}>
          {children(f)}
        </div>
      </div>
    </div>
  );
}

function Cold() {
  const f = useFrame();
  const a = f < bars(1.5) ? rise(f, 0) : fall(f, bars(1.5) - 8, { blur: 8 });
  return (
    <div className="absolute inset-0 grid place-items-center">
      {f < bars(1.5) + 10 ? (
        <div style={{ opacity: a.opacity, filter: a.filter }}>
          <Headline lead="Every AI vendor wants" rest="to run your company." f={f} at={10} stack />
        </div>
      ) : null}
      {f >= bars(1.5) - 4 ? (
        <div className="absolute">
          <Headline lead="On their models." rest="On their terms." f={f} at={bars(1.5)} stack />
        </div>
      ) : null}
    </div>
  );
}

function Reveal() {
  const f = useFrame();
  const lift = interp(f, 60, 100, 0, 1, ease.inOutCubic);
  return (
    <div className="absolute inset-0 grid place-items-center" style={{ perspective: 1400 }}>
      <div
        className="absolute size-40"
        style={{
          opacity: interp(f, 0, 14, 0, 1, ease.outQuad),
          filter: `blur(${interp(f, 0, 22, 14, 0)}px)`,
          transform: `translateY(${-140 * lift}px) scale(${interp(f, 0, 56, 1.12, 1) * (1 - 0.5 * lift)}) rotateY(${interp(f, 0, 80, 30, 0)}deg)`,
        }}
      >
        <IconFrame>
          <KortixLogo variant="icon" />
        </IconFrame>
      </div>
      <div className="absolute top-1/2 mt-4 text-center">
        <Headline
          lead="Own your AI workforce."
          rest="Down to the last permission."
          f={f}
          at={76}
          stack
        />
      </div>
    </div>
  );
}

function Agents() {
  return (
    <Beat lead="Your agents live" rest="in a repo you own.">
      {(f) => (
        <Screen
          src={`${M}/agents.webp`}
          f={f}
          keys={[
            { at: 0, focus: [383, 150, 520, 80], zoom: 1.55 },
            { at: 130, focus: [383, 230, 995, 230], zoom: 1.1 },
          ]}
          ring={{ at: 40, rect: [383, 190, 158, 18] }}
        />
      )}
    </Beat>
  );
}

function Grants() {
  return (
    <Beat lead="Every agent starts with nothing." rest="You grant the rest.">
      {(f) => (
        <Screen
          src={`${M}/agent-connectors.webp`}
          over={{ src: `${M}/agent-connectors-granted.webp`, at: 150 }}
          f={f}
          keys={[
            { at: 0, focus: [718, 132, 626, 400], zoom: 1.5 },
            { at: 120, focus: [718, 280, 626, 90], zoom: 1.9 },
          ]}
          ring={{ at: 100, rect: [732, 296, 598, 64] }}
        />
      )}
    </Beat>
  );
}

function Ceiling() {
  return (
    <Beat lead="A role caps what it can do." rest="Some things stay human.">
      {(f) => (
        <Screen
          src={`${M}/agent-permissions.webp`}
          f={f}
          keys={[
            { at: 0, focus: [718, 132, 626, 380], zoom: 1.45 },
            { at: 110, focus: [718, 690, 626, 170], zoom: 1.75 },
          ]}
          ring={{ at: 140, rect: [732, 786, 598, 66] }}
        />
      )}
    </Beat>
  );
}

function ToolRules() {
  return (
    <Beat lead="Decide per tool:" rest="allow, ask, or block.">
      {(f) => (
        <Screen
          src={`${M}/tool-rules.webp`}
          f={f}
          keys={[
            { at: 0, focus: [402, 190, 870, 500], zoom: 1.25 },
            { at: 110, focus: [402, 470, 870, 220], zoom: 1.6 },
          ]}
          ring={{ at: 130, rect: [1064, 478, 210, 206] }}
        />
      )}
    </Beat>
  );
}

function Approval() {
  return (
    <Beat lead="Approve the call," rest="or deny it with a note.">
      {(f) => (
        <Screen
          src={`${M}/approval.webp`}
          f={f}
          keys={[
            { at: 0, focus: [336, 260, 1090, 330], zoom: 1.2 },
            { at: 110, focus: [840, 600, 590, 100], zoom: 1.6 },
          ]}
          ring={{ at: 140, rect: [1170, 652, 244, 40] }}
        />
      )}
    </Beat>
  );
}

function People() {
  return (
    <Beat lead="Groups decide who can run" rest="which agent." chip="Enterprise">
      {(f) => (
        <Screen
          src={`${M}/groups.webp`}
          f={f}
          keys={[{ at: 0, focus: [486, 80, 768, 180], zoom: 1.6 }]}
          ring={{ at: 60, rect: [486, 190, 768, 56] }}
        />
      )}
    </Beat>
  );
}

function Audit() {
  return (
    <Beat lead="Every action," rest="on the record." chip="Enterprise">
      {(f) => (
        <Screen
          src={`${M}/audit.webp`}
          f={f}
          keys={[
            { at: 0, focus: [486, 80, 768, 110], zoom: 1.7 },
            { at: 120, focus: [486, 150, 768, 60], zoom: 1.9 },
          ]}
          ring={{ at: 140, rect: [486, 150, 610, 40] }}
        />
      )}
    </Beat>
  );
}

const MODELS = ['anthropic', 'openai', 'google', 'deepseek', 'mistral', 'moonshotai'];

function Open() {
  const f = useFrame();
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-10">
      <Headline lead="Open source." rest="Any model. Your servers." f={f} at={-6} stack />
      <div className="flex gap-3">
        {MODELS.map((m, i) => (
          <div
            key={m}
            className="border-border bg-popover grid size-16 place-items-center rounded-2xl border"
            style={rise(f, 40 + stagger(i, 5), { dist: 20, scale: 0.9 })}
          >
            <span
              className="bg-foreground size-7"
              style={{
                mask: `url(/provider-icons/${m}.svg) center / contain no-repeat`,
                WebkitMask: `url(/provider-icons/${m}.svg) center / contain no-repeat`,
              }}
            />
          </div>
        ))}
      </div>
      <p className="text-foreground font-mono text-xl" style={rise(f, 110)}>
        <span className="text-muted-foreground">$ </span>
        <Words text="kortix self-host start" f={f} at={110} gap={3} />
      </p>
    </div>
  );
}

function End() {
  const f = useFrame();
  const out = interp(f, bars(2) - 40, bars(2) - 4, 1, 0, ease.outQuad);
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-6"
      style={{ opacity: out }}
    >
      <div style={rise(f, 0, { dist: 0, scale: 0.94, blur: 10 })}>
        <KortixLogo variant="brandmark" size={56} className="text-foreground" />
      </div>
      <p className="text-muted-foreground text-2xl" style={rise(f, 20)}>
        Own your AI workforce. Down to the last permission.
      </p>
      <p className="text-foreground font-mono text-lg" style={rise(f, 40)}>
        kortix.com
      </p>
    </div>
  );
}

const B = {
  cold: [0, 3],
  reveal: [3, 2],
  agents: [5, 3],
  grants: [8, 3],
  ceiling: [11, 3],
  rules: [14, 3],
  approval: [17, 3],
  people: [20, 2],
  audit: [22, 3],
  open: [25, 3],
  end: [28, 2],
} as const;
const at = (k: keyof typeof B) => bars(B[k][0]);
const len = (k: keyof typeof B) => bars(B[k][1]);

function Sovereign() {
  return (
    <>
      <Shot from={at('cold')} dur={len('cold')} enter="cut" exit="settle">
        <Cold />
      </Shot>
      <Shot from={at('reveal')} dur={len('reveal')} enter="settle">
        <Reveal />
      </Shot>
      <Shot from={at('agents')} dur={len('agents')}>
        <Agents />
      </Shot>
      <Shot from={at('grants')} dur={len('grants')}>
        <Grants />
      </Shot>
      <Shot from={at('ceiling')} dur={len('ceiling')}>
        <Ceiling />
      </Shot>
      <Shot from={at('rules')} dur={len('rules')}>
        <ToolRules />
      </Shot>
      <Shot from={at('approval')} dur={len('approval')}>
        <Approval />
      </Shot>
      <Shot from={at('people')} dur={len('people')}>
        <People />
      </Shot>
      <Shot from={at('audit')} dur={len('audit')} exit="settle">
        <Audit />
      </Shot>
      <Shot from={at('open')} dur={len('open')} enter="settle" exit="settle">
        <Open />
      </Shot>
      <Shot from={at('end')} dur={len('end')} enter="settle" exit="cut">
        <End />
      </Shot>
    </>
  );
}

const cues: Cue[] = [
  { frame: 10, sfx: 'tick', gain: 0.5 },
  { frame: bars(1.5), sfx: 'tick', gain: 0.5 },
  { frame: at('reveal'), sfx: 'impact', gain: 1 },
  ...(['agents', 'grants', 'ceiling', 'rules', 'approval', 'people', 'audit'] as const).map(
    (k) => ({
      frame: at(k) - 10,
      sfx: 'whoosh',
      gain: 0.4,
    }),
  ),
  { frame: at('agents') + 40, sfx: 'tick', gain: 0.45 },
  { frame: at('grants') + 150, sfx: 'click', gain: 0.8 },
  { frame: at('ceiling') + 140, sfx: 'tick', gain: 0.45 },
  { frame: at('rules') + 130, sfx: 'tick', gain: 0.45 },
  { frame: at('approval') + 140, sfx: 'click', gain: 0.8 },
  { frame: at('open') + 110, sfx: 'typing', gain: 0.3 },
  { frame: at('end'), sfx: 'impact', gain: 0.7 },
];

export const sovereignFilm: FilmDef = {
  slug: 'sovereign',
  title: 'Kortix — own your AI workforce',
  description:
    'Sixty seconds on the real product: agents in a repo you own, each starting with no access and granted exactly what it needs.',
  frames: bars(30),
  Film: Sovereign,
  cues,
  audio: '/film/sovereign.m4a',
  score: {
    bars: 30,
    sections: [
      [0, 'intro'],
      [3, 'reveal'],
      [5, 'groove'],
      [25, 'break'],
      [28, 'end'],
    ],
    cycle_from: 4,
    risers: [
      [3, 3],
      [28, 1.5],
    ],
    impacts: [
      [3, 0.9],
      [28, 0.7],
    ],
  },
};
