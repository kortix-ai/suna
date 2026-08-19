'use client';

import {
  ArrowsClockwiseIcon,
  BellIcon,
  BookOpenIcon,
  CloudArrowUpIcon,
  CodeIcon,
  CubeIcon,
  DatabaseIcon,
  DotsThreeIcon,
  FolderIcon,
  GitBranchIcon,
  KeyIcon,
  LightningIcon,
  PlugsConnectedIcon,
  RobotIcon,
  ShieldCheckIcon,
  SparkleIcon,
  TerminalWindowIcon,
  UsersIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useState, type ComponentProps } from 'react';

import {
  Card,
  CardAction,
  CardButton,
  CardContent,
  CardDescription,
  CardEyebrow,
  CardFeature,
  CardFooter,
  CardGroup,
  CardHeader,
  CardImage,
  CardMedia,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Body of the Card section. The `#comp-card` anchor, the heading and the
 * description live on the design-system page; this renders the variants only.
 *
 * Card is one compositional API with two layout axes — `orientation`
 * ("card" | "inline") and `columns` — plus two framing switches (`border`,
 * `separated`). Every block below is one point in that matrix, so the page
 * documents the whole surface rather than a "default" and a "glass".
 *
 * The surface is transparent and borderless by default: a card inherits the
 * substrate under it and leans on hairline dividers plus the magnetic
 * proximity highlight instead of a drawn frame. Each demo therefore sits on a
 * `bg-card/10` frame, the same substrate the rest of this page uses.
 */

// ── demo data ────────────────────────────────────────────

const RUNTIME: { icon: Icon; title: string; description: string }[] = [
  {
    icon: CubeIcon,
    title: 'Sandbox',
    description: 'Every session boots its own cloud sandbox — session_id == sandbox_id.',
  },
  {
    icon: TerminalWindowIcon,
    title: 'Agent server',
    description: 'The kortix-agent daemon is baked into the snapshot, reachable over /p/<id>.',
  },
  {
    icon: PlugsConnectedIcon,
    title: 'OpenCode REST',
    description: 'One transport for every session, proxied through the compatibility layer.',
  },
];

const SURFACES: { icon: Icon; title: string; description: string }[] = [
  { icon: FolderIcon, title: 'Projects', description: 'Provision, share, and archive.' },
  { icon: LightningIcon, title: 'Triggers', description: 'Schedules, webhooks, and events.' },
  { icon: KeyIcon, title: 'Secrets', description: 'Encrypted at rest, injected at boot.' },
  { icon: UsersIcon, title: 'Members', description: 'Roles, invites, and IAM policies.' },
];

const WALLPAPERS = [
  { src: '/wallpapers/silk-dark.jpg', eyebrow: 'Wallpaper', title: 'Silk' },
  { src: '/wallpapers/nebula-dark.jpg', eyebrow: 'Wallpaper', title: 'Nebula' },
];

/** The fills a card action reaches for. CardButton accepts Button's whole
 *  union, so anything in button.tsx works — these are just the sensible ones. */
const BUTTON_VARIANTS: ComponentProps<typeof CardButton>['variant'][] = [
  'default',
  'secondary',
  'outline',
  'ghost',
  'link',
  'brand',
  'destructive',
  'muted',
];

/** Button's labelled sizes, shortest box first. `default` is what a CardButton
 *  renders at when the prop is omitted — Button's own default, not a card one.
 *  The square `icon-*` sizes are in the same union but are not shown here: an
 *  icon-only button needs an accessible name, which is a caller's job. */
const BUTTON_SIZES: ComponentProps<typeof CardButton>['size'][] = [
  'xs',
  'base',
  'toolbar',
  'sm',
  'magic-sm',
  'default',
  'lg',
  'xl',
];

// ── local chrome ─────────────────────────────────────────

/** Mirrors `DemoContainer` on the design-system page (kept local so this file
 *  stays a standalone section, like `icons-section.tsx`). */
function Frame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn('border-border bg-card/10 max-w-full min-w-0 rounded-lg border p-6', className)}
    >
      {children}
    </div>
  );
}

function Variant({
  label,
  note,
  children,
  frameClassName,
}: {
  label: string;
  note: string;
  children: React.ReactNode;
  frameClassName?: string;
}) {
  return (
    <div className="mb-8 last:mb-0">
      <p className="text-muted-foreground mb-1 text-xs tracking-widest uppercase">{label}</p>
      <p className="text-muted-foreground mb-3 max-w-2xl text-sm leading-relaxed">{note}</p>
      <Frame className={frameClassName}>{children}</Frame>
    </div>
  );
}

// ── section ──────────────────────────────────────────────

export function CardSection() {
  const [selected, setSelected] = useState(1);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const notices = [
    { id: 'snapshot', icon: CloudArrowUpIcon, title: 'Snapshot rebuilt', body: 'Ready in 8m 42s.' },
    {
      id: 'migration',
      icon: DatabaseIcon,
      title: 'Migration applied',
      body: '3 statements, 0 errors.',
    },
  ].filter((notice) => !dismissed.includes(notice.id));

  return (
    <div>
      {/* 1 ── anatomy ------------------------------------------------ */}
      <Variant
        label="Anatomy"
        note="A standalone card owns its own tile. Media, eyebrow, title, description, an action pinned top-right, features in the content slot, and a footer of actions — every part is optional."
      >
        <Card className="max-w-sm">
          <CardHeader>
            <CardMedia icon={CubeIcon} />
            <CardEyebrow>Runtime</CardEyebrow>
            <CardTitle>Sandbox session</CardTitle>
            <CardDescription>
              A live cloud sandbox, one per session, reachable over the local API.
            </CardDescription>
            <CardAction>
              <CardButton icon={DotsThreeIcon}>Manage</CardButton>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <CardFeature
              icon={LightningIcon}
              title="Boots on start"
              description="POST /start provisions the sandbox and streams readiness over SSE."
            />
            <CardFeature
              icon={ShieldCheckIcon}
              title="Scoped credentials"
              description="Secrets are injected at boot; nothing is baked into the snapshot."
            />
          </CardContent>
          <CardFooter>
            <CardButton variant="default" icon={TerminalWindowIcon}>
              Open session
            </CardButton>
            <CardButton variant="ghost">Logs</CardButton>
          </CardFooter>
        </Card>
      </Variant>

      {/* 2 ── stacked group ------------------------------------------ */}
      <Variant
        label="Group — stacked list"
        note="The default CardGroup: borderless, one column, hairline dividers between neighbours. Move the cursor down the list — a single magnetic highlight springs to the nearest card and previews where a click lands."
      >
        <CardGroup>
          {RUNTIME.map((item) => (
            <Card key={item.title} label={item.title} onClick={() => {}}>
              <CardHeader>
                <CardMedia icon={item.icon} />
                <CardTitle>{item.title}</CardTitle>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </CardGroup>
      </Variant>

      {/* 3 ── outlined group ----------------------------------------- */}
      <Variant
        label="Group — outlined"
        note='border="outlined" draws one shared frame around the block and clips the highlight and dividers to its corners.'
      >
        <CardGroup border="outlined">
          {SURFACES.slice(0, 3).map((item) => (
            <Card key={item.title} label={item.title} onClick={() => {}}>
              <CardHeader>
                <CardMedia icon={item.icon} />
                <CardTitle>{item.title}</CardTitle>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </CardGroup>
      </Variant>

      {/* 4 ── grid, 2-D proximity ------------------------------------ */}
      <Variant
        label="Grid — 2-D proximity"
        note="columns={2} wraps the group into a grid and resolves the nearest card in two dimensions, so the highlight travels across rows as well as columns."
      >
        <CardGroup columns={2} border="outlined">
          {SURFACES.map((item) => (
            <Card key={item.title} label={item.title} onClick={() => {}}>
              <CardHeader>
                <CardMedia icon={item.icon} />
                <CardTitle>{item.title}</CardTitle>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
              <CardFooter>
                <CardButton>Get started</CardButton>
              </CardFooter>
            </Card>
          ))}
        </CardGroup>
      </Variant>

      {/* 5 ── separated tiles ---------------------------------------- */}
      <Variant
        label="Separated tiles"
        note="separated splits the block into individually-shaped tiles with a gap. Each tile carries its own frame and clip instead of leaning on a shared one."
      >
        <CardGroup columns={3} separated border="outlined">
          {RUNTIME.map((item) => (
            <Card key={item.title} label={item.title} onClick={() => {}}>
              <CardHeader>
                <CardMedia icon={item.icon} />
                <CardTitle>{item.title}</CardTitle>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </CardGroup>
      </Variant>

      {/* 6 ── inline rows -------------------------------------------- */}
      <Variant
        label="Inline"
        note='orientation="inline" turns each card into a horizontal row — leading media, flexible text, trailing footer. The same parts, a table-like rhythm.'
      >
        <CardGroup orientation="inline" border="outlined">
          <Card label="CLI token">
            <CardMedia icon={KeyIcon} />
            <CardHeader>
              <CardTitle>CLI token</CardTitle>
              <CardDescription>Last used 4 minutes ago</CardDescription>
            </CardHeader>
            <CardFooter>
              <CardButton icon={ArrowsClockwiseIcon}>Rotate</CardButton>
            </CardFooter>
          </Card>
          <Card label="Repository">
            <CardMedia icon={GitBranchIcon} />
            <CardHeader>
              <CardTitle>kortix-ai/suna</CardTitle>
              <CardDescription>main — synced</CardDescription>
            </CardHeader>
            <CardFooter>
              <CardButton icon={CodeIcon}>Open</CardButton>
            </CardFooter>
          </Card>
          <Card label="Notifications">
            <CardMedia icon={BellIcon} />
            <CardHeader>
              <CardTitle>Notifications</CardTitle>
              <CardDescription>Email on run failure</CardDescription>
            </CardHeader>
            <CardFooter>
              <CardButton variant="secondary">Configure</CardButton>
            </CardFooter>
          </Card>
        </CardGroup>
      </Variant>

      {/* 7 ── inline + image ----------------------------------------- */}
      <Variant
        label="Inline — with image"
        note="A CardImage in an inline card bleeds to the left edge and runs the full height; the text and actions ride in a centred column beside it, so the footer drops under the copy instead of trailing right."
      >
        <CardGroup orientation="inline" border="outlined">
          {WALLPAPERS.map((wallpaper) => (
            <Card key={wallpaper.title} label={wallpaper.title}>
              <CardImage src={wallpaper.src} alt="" />
              <CardHeader>
                <CardEyebrow>{wallpaper.eyebrow}</CardEyebrow>
                <CardTitle>{wallpaper.title}</CardTitle>
                <CardDescription>
                  Shipped in both themes; the picker reads a static thumbnail.
                </CardDescription>
              </CardHeader>
              <CardFooter>
                <CardButton variant="secondary">Download</CardButton>
                <CardButton>Preview</CardButton>
              </CardFooter>
            </Card>
          ))}
        </CardGroup>
      </Variant>

      {/* 8 ── stacked + banner --------------------------------------- */}
      <Variant
        label="Stacked — with banner"
        note="The same CardImage stacked becomes a 16:9 banner at the top of the tile. The image keeps a fixed 2px radius in every state; the tile's own frame does the clipping."
      >
        <CardGroup columns={2} separated border="outlined">
          {WALLPAPERS.map((wallpaper) => (
            <Card key={wallpaper.title} label={wallpaper.title}>
              <CardImage src={wallpaper.src} alt="" />
              <CardHeader>
                <CardEyebrow>{wallpaper.eyebrow}</CardEyebrow>
                <CardTitle>{wallpaper.title}</CardTitle>
                <CardDescription>
                  Light and dark variants, 6K, ships in the brandkit.
                </CardDescription>
              </CardHeader>
              <CardFooter>
                <CardButton variant="default">Download</CardButton>
              </CardFooter>
            </Card>
          ))}
        </CardGroup>
      </Variant>

      {/* 9 ── media -------------------------------------------------- */}
      <Variant
        label="Media"
        note="CardMedia takes an icon — drawn in a tinted 32×32 tile — or a brand logo. A [logoA, logoB] tuple renders a connected pair for a trigger → target relationship."
      >
        <CardGroup columns={3} separated border="outlined">
          <Card label="Icon tile">
            <CardHeader>
              <CardMedia icon={RobotIcon} />
              <CardTitle>Icon</CardTitle>
              <CardDescription>Tinted tile, blends over the substrate.</CardDescription>
            </CardHeader>
          </Card>
          <Card label="Single logo">
            <CardHeader>
              <CardMedia logo="/usecases/logos/linear.png" logoAlt="Linear" />
              <CardTitle>Logo</CardTitle>
              <CardDescription>Bare mark, no tile, object-contain.</CardDescription>
            </CardHeader>
          </Card>
          <Card label="Logo pair">
            <CardHeader>
              {/* Raster marks here because provider-icons/*.svg are monochrome
                  currentColor files: through an <img> they resolve to black and
                  vanish in dark mode (the app inlines them, or adds dark:invert). */}
              <CardMedia
                logo={['/usecases/logos/linear.png', '/usecases/logos/slack.webp']}
                logoAlt="Linear to Slack"
              />
              <CardTitle>Logo pair</CardTitle>
              <CardDescription>Connected by a hairline — source to target.</CardDescription>
            </CardHeader>
          </Card>
        </CardGroup>
      </Variant>

      {/* 10 ── selection --------------------------------------------- */}
      <Variant
        label="Selected"
        note="selected is persistent state on top of the transient hover: a filled background plus a title that weight-animates normal → semibold. Neighbours drop the hairline that would cut across the fill. Click a row."
      >
        <CardGroup border="outlined">
          {SURFACES.slice(0, 3).map((item, index) => (
            <Card
              key={item.title}
              label={item.title}
              selected={selected === index}
              onClick={() => setSelected(index)}
            >
              <CardHeader>
                <CardMedia icon={item.icon} />
                <CardTitle>{item.title}</CardTitle>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </CardGroup>
      </Variant>

      {/* 11 ── disabled ---------------------------------------------- */}
      <Variant
        label="Disabled"
        note="disabled dims the card and drops the stretched overlay entirely, so it cannot be clicked, tabbed to, or activated by keyboard."
      >
        <CardGroup columns={2} separated border="outlined">
          <Card label="Available" onClick={() => {}}>
            <CardHeader>
              <CardMedia icon={SparkleIcon} />
              <CardTitle>Available</CardTitle>
              <CardDescription>Interactive — hover previews the target.</CardDescription>
            </CardHeader>
          </Card>
          <Card label="Unavailable" disabled onClick={() => {}}>
            <CardHeader>
              <CardMedia icon={DatabaseIcon} />
              <CardTitle>Unavailable</CardTitle>
              <CardDescription>Dimmed, inert, and out of the tab order.</CardDescription>
            </CardHeader>
          </Card>
        </CardGroup>
      </Variant>

      {/* 12 ── dismissible ------------------------------------------- */}
      <Variant
        label="Dismissible"
        note="dismissible adds a ✕ that sits above the stretched overlay, so it stays independently clickable even when the whole card is a link."
      >
        {notices.length > 0 ? (
          <CardGroup columns={2} separated border="outlined">
            {notices.map((notice) => (
              <Card
                key={notice.id}
                label={notice.title}
                dismissible
                onDismiss={() => setDismissed((ids) => [...ids, notice.id])}
              >
                <CardHeader>
                  <CardMedia icon={notice.icon} />
                  <CardTitle>{notice.title}</CardTitle>
                  <CardDescription>{notice.body}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </CardGroup>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-muted-foreground text-sm">All dismissed.</p>
            <CardButton
              variant="secondary"
              icon={ArrowsClockwiseIcon}
              onClick={() => setDismissed([])}
            >
              Reset
            </CardButton>
          </div>
        )}
      </Variant>

      {/* 13 ── clickable --------------------------------------------- */}
      <Variant
        label="Clickable"
        note="href renders a stretched link across the whole card, onClick a stretched button; either way the footer actions stay independently clickable above it. external opens a new tab."
      >
        <CardGroup columns={2} separated border="outlined">
          <Card label="Read the docs" href="https://docs.kortix.com" external>
            <CardHeader>
              <CardMedia icon={BookOpenIcon} />
              <CardTitle>Documentation</CardTitle>
              <CardDescription>Whole card is a link — opens in a new tab.</CardDescription>
            </CardHeader>
            <CardFooter>
              <CardButton href="https://docs.kortix.com" external>
                docs.kortix.com
              </CardButton>
            </CardFooter>
          </Card>
          <Card label="Design system" href="/design-system#comp-card">
            <CardHeader>
              <CardMedia icon={SparkleIcon} />
              <CardTitle>Design system</CardTitle>
              <CardDescription>Internal route — same stretched-link pattern.</CardDescription>
            </CardHeader>
            <CardFooter>
              <CardButton variant="link">/design-system</CardButton>
            </CardFooter>
          </Card>
        </CardGroup>
      </Variant>

      {/* 14 ── card buttons ------------------------------------------ */}
      <Variant
        label="CardButton"
        note="The footer's action control is the app Button. variant and size both take Button's own unions — everything button.tsx ships works here, and omitting either falls through to Button's defaults. On top: an optional icon on either side and an external arrow."
      >
        {/* CardButton stands alone — it needs no Card around it. */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-1">
            {BUTTON_VARIANTS.map((variant) => (
              <CardButton key={variant} variant={variant}>
                {variant}
              </CardButton>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {BUTTON_SIZES.map((size) => (
              <CardButton key={size} size={size} variant="outline">
                {size}
              </CardButton>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <CardButton icon={CloudArrowUpIcon}>Leading icon</CardButton>
            <CardButton icon={ArrowsClockwiseIcon} iconPosition="end">
              Trailing icon
            </CardButton>
            <CardButton href="https://kortix.com" external>
              External
            </CardButton>
            <CardButton disabled>Disabled</CardButton>
          </div>
        </div>
      </Variant>

      {/* 15 ── proximity off ----------------------------------------- */}
      <Variant
        label="Proximity off"
        note="proximityHover={false} keeps the layout and dividers but drops the magnetic highlight — for read-only groups where nothing is clickable."
      >
        <CardGroup border="outlined" proximityHover={false}>
          {RUNTIME.slice(0, 2).map((item) => (
            <Card key={item.title}>
              <CardHeader>
                <CardMedia icon={item.icon} />
                <CardTitle>{item.title}</CardTitle>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </CardGroup>
      </Variant>
    </div>
  );
}
