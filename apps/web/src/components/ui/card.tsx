'use client';

import { Button } from '@/components/ui/button';
import { useProximityHover } from '@/hooks/use-proximity-hover';
import { fontWeights } from '@/lib/font-weight';
import { useIcon, type IconComponent } from '@/lib/icon-context';
import { spring } from '@/lib/springs';
import { cn } from '@/lib/utils';
import { AnimatePresence, m } from 'motion/react';
import Link from 'next/link';
import {
  Children,
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';

// ---------------------------------------------------------------------------
// Card is shadcn/ui's compositional card — the same parts and `data-slot`
// contract (Card, CardHeader, CardTitle, CardDescription, CardAction,
// CardContent, CardFooter) — with the Fluid Functionalism layer on top:
// design tokens, a weight-animated title, and a sibling CardGroup that owns
// layout (stacked list, inline rows, or grid) plus the magnetic proximity
// highlight that previews where a click will land.
//
// Unlike stock shadcn, the surface is transparent and borderless by default:
// cards inherit whatever substrate their parent provides (see the Surfaces
// system) and lean on hairline dividers / the proximity highlight rather than
// a drawn frame. A Card renders fine on its own; inside a CardGroup it
// registers itself so the group's highlight can find it.
// ---------------------------------------------------------------------------

type CardOrientation = 'card' | 'inline';
type CardBorder = 'none' | 'outlined';

// ── Group context ────────────────────────────────────────

interface CardGroupContextValue {
  registerItem: (index: number, element: HTMLElement | null) => void;
  activeIndex: number | null;
  /** Index of the persistently-selected card, or -1. Its neighbours drop the
   *  hairline that would otherwise cut across the selection fill. */
  selectedIndex: number;
  orientation: CardOrientation;
  columns: number;
  count: number;
  /** Individual cards carry their own border/tile shape (separated grids). */
  separated: boolean;
  /** Inner hairline dividers are drawn between adjacent cards. */
  divided: boolean;
  outlined: boolean;
}

const CardGroupContext = createContext<CardGroupContextValue | null>(null);

// ── Per-card context ─────────────────────────────────────
// Lets the compositional parts (title, header, footer…) adapt to the card
// they're inside without threading props: the title reads `emphasized` to
// animate its weight; parts read `orientation` to switch padding/flow.

interface CardContextValue {
  emphasized: boolean;
  orientation: CardOrientation;
  clickable: boolean;
  /** An inline card holding a full CardImage centres its text + actions in a
   *  column beside the image, so the footer drops below the text (hugged and
   *  vertically centred) instead of trailing to the right. */
  hasImage: boolean;
}

const CardContext = createContext<CardContextValue>({
  emphasized: false,
  orientation: 'card',
  clickable: false,
  hasImage: false,
});

// ── CardGroup ────────────────────────────────────────────

interface CardGroupProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onDrag'> {
  /** How each card lays its own content out.
   *  "card" — stacked vertically (media/header on top). "inline" — a
   *  horizontal row (leading media, trailing footer), like a Table row.
   *  @default "card" */
  orientation?: CardOrientation;
  /** Number of grid columns. >1 enables 2-D proximity across rows and columns.
   *  @default 1 */
  columns?: number;
  /** "none" — borderless (default), separated only by subtle dividers.
   *  "outlined" — draws a border: one shared frame when grouped, or one per
   *  card when `separated`. @default "none" */
  border?: CardBorder;
  /** Split the group into individually-shaped cards with a gap between them
   *  (a grid of tiles) instead of one continuous divided block. @default false */
  separated?: boolean;
  /** Enable the magnetic proximity-hover highlight. @default true */
  proximityHover?: boolean;
}

const CardGroup = forwardRef<HTMLDivElement, CardGroupProps>(
  (
    {
      orientation = 'card',
      columns = 1,
      border = 'none',
      separated = false,
      proximityHover = true,
      className,
      children,
      ...props
    },
    ref,
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);

    // >1 column wraps into a grid, where nearest-item must be resolved in two
    // dimensions; a single column is a plain vertical list.
    const axis = columns > 1 ? 'xy' : 'y';
    const { activeIndex, itemRects, sessionRef, handlers, registerItem, measureItems } =
      useProximityHover(containerRef, { axis });

    // Assign each valid child a stable proximity index so callers never thread
    // one through by hand (Table asks for it; here the group owns it).
    const childArray = Children.toArray(children).filter(isValidElement);
    const count = childArray.length;
    const indexed = childArray.map((child, i) =>
      cloneElement(child as ReactElement<{ index?: number }>, { index: i }),
    );
    // Which card is selected — so its neighbours can drop the divider that
    // would otherwise slice through the selection fill.
    const selectedIndex = childArray.findIndex(
      (child) => (child.props as { selected?: boolean }).selected,
    );

    useEffect(() => {
      measureItems();
    }, [measureItems, count, columns, orientation, separated, border]);

    const outlined = border === 'outlined';
    const divided = !separated;

    const contextValue = useMemo<CardGroupContextValue>(
      () => ({
        registerItem,
        activeIndex,
        selectedIndex,
        orientation,
        columns,
        count,
        separated,
        divided,
        outlined,
      }),
      [
        registerItem,
        activeIndex,
        selectedIndex,
        orientation,
        columns,
        count,
        separated,
        divided,
        outlined,
      ],
    );

    const activeRect = proximityHover && activeIndex !== null ? itemRects[activeIndex] : null;

    return (
      <CardGroupContext.Provider value={contextValue}>
        <div
          ref={(node) => {
            (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
          }}
          {...props}
          data-slot="card-group"
          data-orientation={orientation}
          className={cn(
            'relative grid',
            // A shared frame clips the highlight + dividers to its rounded
            // corners; separated tiles clip themselves.
            outlined && !separated && 'border-border/60 overflow-hidden rounded-xl border',
            separated ? 'gap-2' : 'gap-0',
            className,
          )}
          style={{
            gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(0, 1fr))`,
          }}
          onMouseEnter={proximityHover ? handlers.onMouseEnter : undefined}
          onMouseMove={proximityHover ? handlers.onMouseMove : undefined}
          onMouseLeave={proximityHover ? handlers.onMouseLeave : undefined}
        >
          {/* Proximity highlight — a single magnetic layer that springs to the
              card nearest the cursor, previewing where a click will land. */}
          <AnimatePresence>
            {activeRect && (
              <m.div
                key={sessionRef.current}
                aria-hidden
                layout
                className="bg-hover pointer-events-none absolute z-0 rounded-xl"
                style={{
                  top: activeRect.top,
                  left: activeRect.left,
                  width: activeRect.width,
                  height: activeRect.height,
                }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: spring.fast.exit }}
                transition={{ ...spring.fast, opacity: { duration: 0.08 } }}
              />
            )}
          </AnimatePresence>

          {indexed}
        </div>
      </CardGroupContext.Provider>
    );
  },
);

CardGroup.displayName = 'CardGroup';

// ── Card ─────────────────────────────────────────────────

interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onClick'> {
  /** Makes the whole card an interactive target; proximity hover previews it.
   *  Renders a stretched link when `href` is set, else a stretched button. */
  onClick?: () => void;
  href?: string;
  external?: boolean;
  /** Accessible name for the stretched link/button when the whole card is
   *  clickable (the card's visible title isn't wired up automatically). */
  label?: string;
  /** Persistent selected state, on top of the transient proximity hover. */
  selected?: boolean;
  disabled?: boolean;
  /** Shows a dismiss (✕) button in the corner. */
  dismissible?: boolean;
  onDismiss?: () => void;
  /** Injected by CardGroup — do not set by hand. */
  index?: number;
}

const Card = forwardRef<HTMLDivElement, CardProps>(
  (
    {
      onClick,
      href,
      external,
      label,
      selected = false,
      disabled = false,
      dismissible = false,
      onDismiss,
      index,
      className,
      children,
      ...props
    },
    ref,
  ) => {
    const internalRef = useRef<HTMLDivElement>(null);
    const group = useContext(CardGroupContext);
    const XIcon = useIcon('x');

    const orientation = group?.orientation ?? 'card';
    const columns = group?.columns ?? 1;
    const count = group?.count ?? 1;
    const separated = group?.separated ?? true;
    const divided = group?.divided ?? false;
    const outlined = group?.outlined ?? false;
    const activeIndex = group?.activeIndex ?? null;
    const selectedIndex = group?.selectedIndex ?? -1;

    // Depend on the stable registerItem callback, not the whole group context —
    // the context object's identity changes on every proximity/selection frame,
    // which would otherwise re-register every card each frame.
    const registerItem = group?.registerItem;
    useEffect(() => {
      if (index === undefined || !registerItem) return;
      registerItem(index, internalRef.current);
      return () => registerItem(index, null);
    }, [index, registerItem]);

    // Divider geometry: draw a hairline toward the neighbour below / to the
    // right, but drop it next to the active OR selected card so the highlight
    // and selection fill read clean (the same trick Table uses on row borders).
    const col = index !== undefined ? index % columns : 0;
    const hasBelow = index !== undefined && index + columns < count;
    const hasRight = index !== undefined && col < columns - 1 && index + 1 < count;
    const self = index ?? -1;
    const touchesBelow = (i: number) => i === self || i === self + columns;
    const touchesRight = (i: number) => i === self || i === self + 1;
    const showBottom =
      divided && hasBelow && !(touchesBelow(activeIndex ?? -1) || touchesBelow(selectedIndex));
    const showRight =
      divided && hasRight && !(touchesRight(activeIndex ?? -1) || touchesRight(selectedIndex));

    const isInline = orientation === 'inline';
    // An inline card with a full-bleed image reflows so its actions stack under
    // the text (see the body wrapper below + CardHeader/CardFooter). Match the
    // image child by identity OR displayName so detection and the split below
    // agree even when module identity drifts (e.g. HMR duplication).
    const isCardImage = (child: ReactNode) =>
      isValidElement(child) &&
      (child.type === CardImage ||
        (child.type as { displayName?: string })?.displayName === 'CardImage');
    const hasImage = Children.toArray(children).some(isCardImage);
    const inlineImage = isInline && hasImage;
    const clickable = !!href || !!onClick;
    // Title weight follows the persistent selected state only — proximity hover
    // previews via the highlight fill, not by bolding the label.
    const emphasized = selected;

    // A standalone card (no group) is its own tile — always rounded + clipped.
    // Inside a group, a separated tile carries its own rounding + clip only when
    // it draws a visible frame; a borderless separated tile has no surface to
    // hug, so it stays unclipped and its media reads as a plain square, and a
    // card in a continuous block leans on the shared group frame for both.
    const tileShape = !group
      ? 'rounded-xl overflow-hidden'
      : separated && outlined
        ? 'rounded-xl overflow-hidden border border-border/60'
        : '';

    // Stretched overlay makes the whole card the click target while keeping
    // action buttons (higher z) independently clickable — the accessible
    // alternative to nesting interactive elements inside a button/anchor. A
    // disabled card drops the overlay entirely so it can't be tabbed to or
    // activated by keyboard (pointer-events-none only blocks the mouse).
    const overlay =
      clickable && !disabled ? (
        href ? (
          <Link
            href={href}
            onClick={onClick}
            target={external ? '_blank' : undefined}
            rel={external ? 'noopener noreferrer' : undefined}
            aria-label={label}
            className="absolute inset-0 z-20 rounded-[inherit] outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]"
          />
        ) : (
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            aria-pressed={selected || undefined}
            className="absolute inset-0 z-20 rounded-[inherit] outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]"
          />
        )
      ) : null;

    const cardContext = useMemo<CardContextValue>(
      () => ({ emphasized, orientation, clickable, hasImage }),
      [emphasized, orientation, clickable, hasImage],
    );

    // Inline image cards wrap their non-image parts in a centred column so the
    // title, description, and actions hug together and sit vertically centred
    // against the image instead of stretching to its full height.
    let body: ReactNode = children;
    if (inlineImage) {
      const parts = Children.toArray(children);
      const image = parts.find(isCardImage);
      const rest = parts.filter((part) => part !== image);
      body = (
        <>
          {image}
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-2 py-3.5 pr-4">
            {rest}
          </div>
        </>
      );
    }

    return (
      <CardContext.Provider value={cardContext}>
        <div
          ref={(node) => {
            (internalRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
          }}
          data-slot="card"
          data-proximity-index={index}
          data-selected={selected || undefined}
          data-orientation={orientation}
          aria-disabled={disabled || undefined}
          className={cn(
            'group/card relative z-10 min-h-[60px] min-w-0',
            inlineImage
              ? // Image on the left; the text + actions ride in a centred
                // column beside it (see the wrapper in the body below).
                'flex flex-row items-center gap-3'
              : isInline
                ? 'flex flex-row items-center gap-3 pl-4'
                : 'flex flex-col pb-4',
            // Standalone (no group) cards can't lean on the group highlight, so
            // they carry their own hover tint when interactive.
            !group && clickable && !disabled && 'hover:bg-hover transition-colors duration-80',
            tileShape,
            disabled && 'pointer-events-none opacity-50',
            className,
          )}
          {...props}
        >
          {/* Persistent selected fill + dividers sit behind the static content
              (-z-10); the stretched overlay (z-20) sits above content so the
              whole card is clickable, and actions/dismiss (z-30) rise above the
              overlay to stay independently interactive. */}
          {selected && (
            <span
              aria-hidden
              className="bg-active pointer-events-none absolute inset-0 -z-10 rounded-xl"
            />
          )}

          {/* Dividers between borderless neighbours. Where both hairlines meet,
              the vertical one stops 1px short so the horizontal hairline owns
              the crossing pixel — two 60% lines would otherwise stack there and
              read brighter than the rest of the grid. */}
          {showBottom && (
            <span
              aria-hidden
              className="bg-border/60 pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-px"
            />
          )}
          {showRight && (
            <span
              aria-hidden
              className={cn(
                'bg-border/60 pointer-events-none absolute top-0 right-0 -z-10 w-px',
                showBottom ? 'bottom-px' : 'bottom-0',
              )}
            />
          )}

          {overlay}

          {body}

          {/* Dismiss control sits above the stretched overlay. */}
          {dismissible && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onDismiss}
              aria-label="Dismiss"
              className="text-muted-foreground hover:text-foreground absolute top-2 right-2 z-30"
            >
              {/* Explicit size class so Button's
                  `[&_svg:not([class*='size-'])]:size-4` rule leaves the glyph
                  at the card's 15px rather than snapping it to 16px. */}
              <XIcon size={15} strokeWidth={1.5} className="size-[15px]" />
            </Button>
          )}
        </div>
      </CardContext.Provider>
    );
  },
);

Card.displayName = 'Card';

// ── CardHeader ───────────────────────────────────────────
// shadcn's header grid: title + description stack, with CardAction pinned to
// the top-right column. In an inline card it becomes the flexible text column
// between the leading media and trailing footer.

const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { orientation, hasImage } = useContext(CardContext);
    const inlineImage = orientation === 'inline' && hasImage;
    return (
      <div
        ref={ref}
        data-slot="card-header"
        className={cn(
          'grid auto-rows-min items-start gap-1 has-data-[slot=card-action]:grid-cols-[1fr_auto]',
          // With an action present the header is two columns, but only the
          // action belongs in the second one. Auto-placement would otherwise
          // flow a third sibling (media, eyebrow…) into the free right-hand
          // cell and park the description beside the title.
          '[&>*:not([data-slot=card-action])]:col-start-1',
          inlineImage
            ? 'min-w-0'
            : orientation === 'inline'
              ? 'min-w-0 flex-1 py-3.5'
              : 'px-4 pt-4',
          className,
        )}
        {...props}
      />
    );
  },
);

CardHeader.displayName = 'CardHeader';

// ── CardTitle ────────────────────────────────────────────

const CardTitle = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(
  ({ className, children, ...props }, ref) => {
    const { emphasized, orientation } = useContext(CardContext);
    // Inline rows trim the title to cap height so it centres tightly against
    // the media/actions; stacked cards keep the natural line box.
    const trim = orientation === 'inline' ? '[text-box:trim-both_cap_alphabetic]' : '';
    // Ghost-span pattern: an invisible semibold copy reserves the width so the
    // resting→active weight animation never reflows the row.
    return (
      <span
        ref={ref}
        data-slot="card-title"
        className={cn('inline-grid text-[14px] leading-snug', className)}
        {...props}
      >
        <span
          className={cn('invisible col-start-1 row-start-1', trim)}
          style={{ fontVariationSettings: fontWeights.semibold }}
          aria-hidden="true"
        >
          {children}
        </span>
        <span
          className={cn(
            'text-foreground col-start-1 row-start-1 transition-[font-variation-settings] duration-80',
            trim,
          )}
          style={{
            // normal → semibold on emphasis, matching nav-item / menu-item /
            // table (the opsz-paired tokens keep the advance width ~constant).
            fontVariationSettings: emphasized ? fontWeights.semibold : fontWeights.normal,
          }}
        >
          {children}
        </span>
      </span>
    );
  },
);

CardTitle.displayName = 'CardTitle';

// ── CardDescription ──────────────────────────────────────

const CardDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p
      ref={ref}
      data-slot="card-description"
      className={cn('text-muted-foreground text-[14px] leading-normal', className)}
      {...props}
    />
  ),
);

CardDescription.displayName = 'CardDescription';

// ── CardAction ───────────────────────────────────────────
// Pinned to the header's top-right column (shadcn's slot). Sits above the
// stretched overlay so any control inside stays independently clickable.

const CardAction = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="card-action"
      className={cn(
        'relative z-30 col-start-2 row-span-2 row-start-1 self-start justify-self-end',
        className,
      )}
      {...props}
    />
  ),
);

CardAction.displayName = 'CardAction';

// ── CardContent ──────────────────────────────────────────

const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { orientation } = useContext(CardContext);
    return (
      <div
        ref={ref}
        data-slot="card-content"
        className={cn(orientation === 'inline' ? '' : 'px-4 pt-3', className)}
        {...props}
      />
    );
  },
);

CardContent.displayName = 'CardContent';

// ── CardFooter ───────────────────────────────────────────
// Actions row. Rises above the stretched overlay (z-30) so buttons stay
// clickable. In an inline card it becomes the trailing, right-aligned slot.

const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { orientation, hasImage } = useContext(CardContext);
    const inlineImage = orientation === 'inline' && hasImage;
    return (
      <div
        ref={ref}
        data-slot="card-footer"
        className={cn(
          'relative z-30 flex items-center gap-1',
          inlineImage
            ? // Under the text, left-aligned in natural order (the inline
              // wrapper owns the spacing).
              'flex-wrap'
            : orientation === 'inline'
              ? 'ml-auto shrink-0 pr-4'
              : 'flex-wrap px-4 pt-3',
          className,
        )}
        {...props}
      />
    );
  },
);

CardFooter.displayName = 'CardFooter';

// ── CardMedia ────────────────────────────────────────────
// FF addition: a leading icon or brand logo(s). Not part of shadcn's anatomy,
// but the connective tissue most product cards need. A tuple renders a
// connected logo pair (e.g. a trigger — target).

type CardLogo = string | [string, string];

interface CardMediaProps {
  logo?: CardLogo;
  logoAlt?: string;
  icon?: IconComponent;
  size?: number;
  className?: string;
}

function CardMedia({ logo, logoAlt, icon: Icon, size = 22, className }: CardMediaProps) {
  const { orientation } = useContext(CardContext);
  // Stacked: sits in the header grid; add an extra 8px so the gap below the
  // icon reads 12px (header gap-1 + mb-2). Inline: leading slot — the card owns
  // the left inset, so no extra padding here.
  const wrap = cn(orientation === 'inline' ? '' : 'mb-2', className);

  if (logo) {
    const logos = Array.isArray(logo) ? logo : [logo];
    return (
      <span
        data-slot="card-media"
        className={cn('inline-flex shrink-0 items-center gap-1.5', wrap)}
      >
        {logos.map((src, i) => (
          <span key={i} className="inline-flex items-center gap-1.5">
            {i > 0 && <span aria-hidden className="bg-border h-px w-2" />}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={logoAlt ?? ''}
              width={size}
              height={size}
              className="rounded-lg object-contain"
              style={{ width: size, height: size }}
            />
          </span>
        ))}
      </span>
    );
  }
  if (Icon) {
    // The icon sits in a 32×32 tinted tile so it reads as a media slot rather
    // than a bare glyph. The tile is an overlay tint (not a solid surface) so it
    // blends over whatever is behind it — the substrate or the hover highlight.
    return (
      <span
        data-slot="card-media"
        className={cn(
          'bg-hover inline-flex size-8 shrink-0 items-center justify-center rounded-lg',
          wrap,
        )}
      >
        <Icon size={18} strokeWidth={1.5} className="text-muted-foreground" />
      </span>
    );
  }
  return null;
}

// ── CardImage ────────────────────────────────────────────
// FF addition: the prominent, full-bleed image (distinct from a small logo).
// Stacked → a top banner; inline → a full-height leading image on the left that
// bleeds past the card's left inset to sit flush against the edge.

interface CardImageProps {
  src: string;
  alt?: string;
  className?: string;
}

function CardImage({ src, alt, className }: CardImageProps) {
  const { orientation } = useContext(CardContext);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt ?? ''}
      data-slot="card-image"
      // The image keeps a fixed 2px corner radius in every state — stacked or
      // inline, framed or borderless — rather than inheriting a frame's larger
      // clip. (A framed tile still clips the surrounding surface as before.)
      className={cn(
        'rounded-[2px] object-cover',
        orientation === 'inline' ? 'size-40 shrink-0' : 'aspect-[16/9] w-full',
        className,
      )}
    />
  );
}

// A stable marker so the Card can recognise an image child by name, surviving
// module-identity mismatches (e.g. HMR duplication) that break `type ===`.
CardImage.displayName = 'CardImage';

// ── CardEyebrow ──────────────────────────────────────────
// Small uppercase label above the title (e.g. "New Model").

const CardEyebrow = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      data-slot="card-eyebrow"
      className={cn('text-muted-foreground text-[11px] tracking-wide uppercase', className)}
      style={{ fontVariationSettings: fontWeights.semibold }}
      {...props}
    />
  ),
);

CardEyebrow.displayName = 'CardEyebrow';

// ── CardFeature ──────────────────────────────────────────
// FF addition: an icon + title + description row, for feature lists inside
// CardContent.

interface CardFeatureProps {
  icon?: IconComponent;
  title: string;
  description?: string;
}

function CardFeature({ icon: Icon, title, description }: CardFeatureProps) {
  return (
    <div data-slot="card-feature" className="flex items-start gap-2.5">
      {Icon && (
        <Icon size={16} strokeWidth={1.5} className="text-muted-foreground mt-0.5 shrink-0" />
      )}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span
          className="text-foreground text-[13px] [text-box:trim-both_cap_alphabetic]"
          style={{ fontVariationSettings: fontWeights.medium }}
        >
          {title}
        </span>
        {description && (
          <span className="text-muted-foreground text-[12px] leading-relaxed">{description}</span>
        )}
      </div>
    </div>
  );
}

// ── CardButton ───────────────────────────────────────────
// The footer's action control. It is the app's <Button> underneath — same
// variants, fills, sizing, disabled handling, and focus ring as every other
// button in the product — with only the card-specific bits layered on: it rises
// above the stretched overlay (z-30), takes an optional icon on either side, and
// appends an outward arrow when the href is external. Renders an anchor (via
// `asChild`) when `href` is set.

/** Button's own variant and size unions, verbatim. Card defines neither of its
 *  own: everything Button ships is available here, and stays available as
 *  Button grows. Both props are left undefined by default, so Button's
 *  `defaultVariants` decide — `default` / `default`. */
type CardButtonVariant = ComponentProps<typeof Button>['variant'];
type CardButtonSize = ComponentProps<typeof Button>['size'];

interface CardButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
  variant?: CardButtonVariant;
  size?: CardButtonSize;
  icon?: IconComponent;
  iconPosition?: 'start' | 'end';
  /** Opens the href in a new tab and appends an outward arrow glyph. */
  external?: boolean;
  disabled?: boolean;
}

function CardButton({
  children,
  onClick,
  href,
  variant,
  size = 'sm',
  icon: Icon,
  iconPosition,
  external = false,
  disabled = false,
}: CardButtonProps) {
  const ArrowRight = useIcon('arrow-right');
  const position = iconPosition ?? (external ? 'end' : 'start');

  // No size class on either glyph: Button's own svg rules own the scale, so an
  // icon tracks whichever `size` the caller picked instead of being pinned.
  const glyph = Icon ? (
    <Icon
      strokeWidth={1.5}
      className="shrink-0 transition-[stroke-width] duration-80 group-hover/action:stroke-[2]"
    />
  ) : null;
  const externalGlyph = external ? (
    <ArrowRight
      strokeWidth={1.5}
      className="shrink-0 -rotate-45 transition-[stroke-width] duration-80 group-hover/action:stroke-[2]"
    />
  ) : null;

  const inner = (
    <>
      {position === 'start' && glyph}
      <span className="[text-box:trim-both_cap_alphabetic]">{children}</span>
      {position === 'end' && glyph}
      {externalGlyph}
    </>
  );

  // Button owns the whole box — height, padding, radius, type scale. The card
  // adds only what the surface needs: a hover group for the glyph, a lift above
  // the stretched overlay, and `link`'s bare-text box.
  const classes = cn('group/action relative z-30', variant === 'link' && 'h-auto px-0');

  if (href) {
    return (
      <Button asChild variant={variant} size={size} className={classes}>
        <Link
          href={href}
          onClick={onClick}
          target={external ? '_blank' : undefined}
          rel={external ? 'noopener noreferrer' : undefined}
        >
          {inner}
        </Link>
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={onClick}
      disabled={disabled}
      className={classes}
    >
      {inner}
    </Button>
  );
}

export {
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
};
export type {
  CardButtonProps,
  CardButtonSize,
  CardButtonVariant,
  CardGroupProps,
  CardLogo,
  CardProps,
};
