'use client';

import { StarIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

import { MarkdownImage, MarkdownLink } from '@/components/markdown/unified-markdown';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { STATUS_DOT } from '@/components/ui/status';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { CARD_TEXT_RATIO, cardImageShape, cardListLayout, type CardShape, masonryColumns, UNKNOWN_RATIO } from '@kortix/shared/genui-layout';

import type { GenuiComponentProps, GenuiNode } from '../sdk';
import { badgeTone, GenuiImageGridContext } from './inline';

export const kids = (value: unknown): GenuiNode[] => (Array.isArray(value) ? (value as GenuiNode[]) : []);

/** Masonry shows at most this many images; a "+N" tile after them shows the rest. */
const GALLERY_SHOWN = 6;
/**
 * Two or more images (Paper Image 17, masonry): two columns, each image at its own aspect ratio, so
 * nothing is cropped, and each image placed in the shorter column. The ratios are read from the images as
 * they load; until then a tile counts as 4:3. The columns end level (see `tile` below). The first image
 * always shows its caption; the others show theirs on hover or focus.
 */
function GenuiGallery({ images, renderChild }: { images: GenuiNode[]; renderChild: GenuiComponentProps['renderChild'] }) {
  const t = useTranslations('genui');
  const [all, setAll] = useState(false);
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const overflow = !all && images.length > GALLERY_SHOWN;
  const shown = overflow ? images.slice(0, GALLERY_SHOWN - 1) : images;

  // `load` does not bubble, so one capture listener on the gallery hears every image in it, including
  // one the browser had cached and finished before this effect ran.
  const galleryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const gallery = galleryRef.current;
    if (!gallery) return;
    const read = (img: HTMLImageElement) => {
      const id = img.closest<HTMLElement>('[data-gallery-tile]')?.dataset.galleryTile;
      if (!id || !img.naturalWidth) return;
      const ratio = img.naturalHeight / img.naturalWidth;
      setRatios((known) => (known[id] === ratio ? known : { ...known, [id]: ratio }));
    };
    gallery.querySelectorAll('img').forEach((img) => img.complete && read(img));
    const onLoad = (event: Event) => event.target instanceof HTMLImageElement && read(event.target);
    gallery.addEventListener('load', onLoad, true);
    return () => gallery.removeEventListener('load', onLoad, true);
  }, [shown.length]);

  const ratioOf = (i: number) => (i < shown.length ? (ratios[shown[i]!.id] ?? UNKNOWN_RATIO) : UNKNOWN_RATIO);
  const count = shown.length + (overflow ? 1 : 0);
  // Two images: one row, both the same height, each as wide as its shape asks (width share = 1 / ratio),
  // so neither is cropped. Three or more: masonry columns; a shorter column shares its extra height among
  // its tiles in proportion (`flexGrow` = ratio), and each image covers its tile, so every crop stays small
  // and both columns end level.
  const pair = count === 2;
  const tile = (i: number) => {
    const ratio = ratioOf(i);
    const style = pair ? { aspectRatio: 1 / ratio, flexGrow: 1 / ratio, flexBasis: 0 } : { aspectRatio: 1 / ratio, flexGrow: ratio };
    const className = 'relative min-h-0 min-w-0 overflow-hidden rounded-lg';
    if (i < shown.length) {
      const image = shown[i]!;
      return (
        <div key={image.id} data-gallery-tile={image.id} className={className} style={style}>
          <GenuiImageGridContext.Provider value={i === 0 ? 'lead' : 'tile'}>{renderChild(image)}</GenuiImageGridContext.Provider>
        </div>
      );
    }
    return (
      <button
        key="more"
        type="button"
        onClick={() => setAll(true)}
        className={cn(className, 'bg-terminal-surface text-terminal-fg flex flex-col items-center justify-center gap-0.5')}
        style={style}
      >
        <span className="text-2xl font-medium tabular-nums">+{images.length - shown.length}</span>
        <span className="text-terminal-fg/65 text-xs">{t('viewAllImages', { count: images.length })}</span>
      </button>
    );
  };
  if (pair) {
    return (
      <div ref={galleryRef} className="flex gap-1.5">
        {tile(0)}
        {tile(1)}
      </div>
    );
  }
  const columns = masonryColumns(Array.from({ length: count }, (_, i) => ratioOf(i)));
  return (
    <div ref={galleryRef} className="flex items-stretch gap-1.5">
      {columns.map((column, c) => (
        <div key={c} className="flex min-w-0 flex-1 flex-col gap-1.5">
          {column.map(tile)}
        </div>
      ))}
    </div>
  );
}

export function GenuiStack({ props, renderChild }: GenuiComponentProps) {
  const children = kids(props.children);
  // Two or more images and nothing else read as one gallery, whichever direction the model wrote.
  if (children.length > 1 && children.every((child) => child.type === 'Image')) {
    return <GenuiGallery images={children} renderChild={renderChild} />;
  }
  // Two or more cards and nothing else read as one list (a hotel or product shortlist), like an image gallery.
  if (children.length > 1 && children.every((child) => child.type === 'Card')) {
    return <GenuiCardList cards={children} layout={props.layout === 'list' || props.layout === 'grid' ? props.layout : undefined} />;
  }
  const row = props.direction === 'row';
  return (
    <div className={cn(row ? 'flex flex-wrap gap-3 *:min-w-48 *:flex-1' : 'flex flex-col gap-4')}>
      {children.map(renderChild)}
    </div>
  );
}

/** A Card badge sits on the image as a surface pill with a tone dot (Paper Card 07). Its label stays ink (D5). */
function CardBadge({ badge }: { badge: GenuiNode }) {
  return (
    <span className="bg-background text-foreground inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap">
      <span className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[badgeTone(badge.props.tone)])} aria-hidden />
      {String(badge.props.label)}
    </span>
  );
}

/** ★ 4.7 (33,899) · price: the rating in ink, the review count muted, the price after a separator. */
function CardRating({ rating, reviews, price }: { rating: unknown; reviews: unknown; price: unknown }) {
  const locale = useLocale();
  if (typeof rating !== 'number' && !price) return null;
  return (
    <span className="text-foreground flex flex-wrap items-center gap-x-1.5 text-sm tabular-nums">
      {typeof rating === 'number' ? (
        <span className="flex items-center gap-1">
          <StarIcon className="size-3.5 shrink-0" weight="fill" aria-hidden />
          {rating.toLocaleString(locale, { maximumFractionDigits: 1 })}
          {typeof reviews === 'number' ? <span className="text-muted-foreground">({reviews.toLocaleString(locale)})</span> : null}
        </span>
      ) : null}
      {typeof rating === 'number' && price ? <span className="text-muted-foreground">·</span> : null}
      {price ? <span>{String(price)}</span> : null}
    </span>
  );
}

/** Below this list width the cards stack in one column. */
const CARD_TWO_COLUMNS_MIN = 480;

/** The text of a card in either layout: title link, rating, location line, description, and the badges as "Luxury · Heritage". */
function CardText({ props }: { props: GenuiNode['props'] }) {
  const tags = kids(props.badges).map((badge) => String(badge.props.label));
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      {/* The title link reads as the item's name: ink with an underline, not the link blue. */}
      <span className="text-foreground [&_a]:text-foreground [&_a]:decoration-border hover:[&_a]:decoration-foreground text-base font-medium text-balance [&_a]:underline [&_a]:underline-offset-4">
        {props.href ? <MarkdownLink href={String(props.href)}>{String(props.title)}</MarkdownLink> : String(props.title)}
      </span>
      <CardRating rating={props.rating} reviews={props.reviews} price={props.price} />
      {props.subtitle ? <span className="text-muted-foreground text-xs">{String(props.subtitle)}</span> : null}
      {props.body ? <p className="text-foreground text-sm text-pretty">{String(props.body)}</p> : null}
      {tags.length > 0 ? <span className="text-muted-foreground text-xs">{tags.join(' · ')}</span> : null}
    </div>
  );
}

/**
 * Two or more Cards (a shortlist of hotels, products, places, books), in one of two layouts (`cardListLayout`):
 * - grid: masonry, each card its photo at its own shape (`cardImageShape`) above its text. Each card goes into
 *   the column that is shorter so far, so a ranked list still reads left to right, top to bottom.
 * - list: one row per card, a small square thumbnail (the whole image) beside the text, hairlines between rows.
 * Without a hint the list shows first, and switches to the grid once most loaded images prove to be photos.
 */
function GenuiCardList({ cards, layout }: { cards: GenuiNode[]; layout?: 'list' | 'grid' }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [shapes, setShapes] = useState<Record<string, CardShape>>({});
  const [columns, setColumns] = useState(2);
  const mode = cardListLayout(layout, Object.values(shapes));

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(([entry]) => setColumns(entry!.contentRect.width < CARD_TWO_COLUMNS_MIN ? 1 : 2));
    observer.observe(list);
    // `load` does not bubble: one capture listener hears every photo, and `complete` covers a cached one.
    const read = (img: HTMLImageElement) => {
      const id = img.closest<HTMLElement>('[data-card]')?.dataset.card;
      if (!id || !img.naturalWidth) return;
      const shape = cardImageShape(img.naturalWidth, img.naturalHeight);
      setShapes((known) => (known[id]?.ratio === shape.ratio && known[id]?.fit === shape.fit ? known : { ...known, [id]: shape }));
    };
    list.querySelectorAll('img').forEach((img) => img.complete && read(img));
    const onLoad = (event: Event) => event.target instanceof HTMLImageElement && read(event.target);
    list.addEventListener('load', onLoad, true);
    return () => {
      observer.disconnect();
      list.removeEventListener('load', onLoad, true);
    };
  }, [cards.length, mode]);

  if (mode === 'list') {
    return (
      <div ref={listRef}>
        <ul className="divide-border flex flex-col divide-y">
          {cards.map(({ id, props }) => (
            <li key={id} data-card={id} className="flex gap-4 py-4 first:pt-0 last:pb-0">
              {props.image ? (
                <div className="bg-muted size-18 shrink-0 self-start overflow-hidden rounded-lg p-1.5 [&>span]:size-full [&_img]:size-full [&_img]:rounded-none [&_img]:object-contain [&_img]:outline-0">
                  <MarkdownImage src={String(props.image)} alt="" flush compact />
                </div>
              ) : null}
              <CardText props={props} />
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const heights = cards.map(({ id, props }) => (props.image ? (shapes[id]?.ratio ?? UNKNOWN_RATIO) : 0) + CARD_TEXT_RATIO);
  return (
    <div ref={listRef} className="flex items-start gap-4">
      {masonryColumns(heights, columns).map((column, c) => (
        <ul key={c} className="flex min-w-0 flex-1 flex-col gap-6">
          {column.map((i) => {
            const { id, props } = cards[i]!;
            const shape = shapes[id] ?? cardImageShape(0, 0);
            return (
              <li key={id} data-card={id} className="flex flex-col gap-3">
                {props.image ? (
                  <div
                    className={cn(
                      'bg-muted overflow-hidden rounded-lg [&>span]:size-full [&_img]:size-full [&_img]:rounded-none [&_img]:outline-0',
                      shape.fit === 'contain' ? '[&_img]:object-contain' : '[&_img]:object-cover',
                      shape.inset && 'p-8',
                    )}
                    style={{ aspectRatio: 1 / shape.ratio }}
                  >
                    <MarkdownImage src={String(props.image)} alt="" flush />
                  </div>
                ) : null}
                <CardText props={props} />
              </li>
            );
          })}
        </ul>
      ))}
    </div>
  );
}

export function GenuiCard({ props }: GenuiComponentProps) {
  const badges = kids(props.badges);
  const title = props.href ? <MarkdownLink href={props.href}>{props.title}</MarkdownLink> : props.title;
  const pills = badges.length > 0 ? badges.map((badge) => <CardBadge key={badge.id} badge={badge} />) : null;
  return (
    // Inset image well (Paper Card 06): a 6px inset, so the image radius nests inside the card's.
    <div className={cn('border-border bg-background flex flex-col gap-3 rounded-xl border', props.image ? 'p-1.5 pb-3.5' : 'px-4 py-3.5')}>
      {props.image ? (
        <div className="bg-card relative h-40 overflow-hidden rounded-lg [&>span]:size-full [&_img]:size-full [&_img]:rounded-none [&_img]:object-cover [&_img]:outline-0">
          <MarkdownImage src={props.image} alt="" flush />
          {pills ? <div className="absolute top-2.5 left-2.5 flex flex-wrap gap-1.5">{pills}</div> : null}
        </div>
      ) : null}
      <div className={cn('flex flex-col gap-1', props.image && 'px-2.5')}>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-foreground min-w-0 text-sm font-medium text-balance">{title}</span>
          {props.subtitle ? <span className="text-foreground max-w-1/2 shrink-0 text-right font-mono text-xs">{props.subtitle}</span> : null}
        </div>
        <CardRating rating={props.rating} reviews={props.reviews} price={props.price} />
        {props.body ? <p className="text-muted-foreground text-sm text-pretty">{props.body}</p> : null}
        {/* Without an image the pills sit under the body, on the muted well instead of the surface. */}
        {pills && !props.image ? <div className="flex flex-wrap gap-1.5 pt-1.5 [&>span]:bg-muted">{pills}</div> : null}
      </div>
    </div>
  );
}

export function GenuiTabs({ props, renderChild, streaming }: GenuiComponentProps) {
  const tabs = kids(props.tabs);
  if (tabs.length === 0) return null;
  // While streaming, show the tab being written so progress is visible (spec §6.3).
  const value = streaming ? tabs[tabs.length - 1]!.id : undefined;
  return (
    <Tabs defaultValue={tabs[0]!.id} value={value} className="gap-3">
      {/* Long labels: each truncates (full text on hover) and the row scrolls inside the message column. */}
      <div className="max-w-full overflow-x-auto">
        <TabsList>
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id} title={String(tab.props.label)}>
              <span className="max-w-48 truncate">{String(tab.props.label)}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id} className="flex flex-col gap-4">
          {kids(tab.props.children).map(renderChild)}
        </TabsContent>
      ))}
    </Tabs>
  );
}

export function GenuiAccordion({ props, renderChild }: GenuiComponentProps) {
  return (
    <Accordion type="multiple">
      {kids(props.items).map((item) => (
        <AccordionItem key={item.id} value={item.id}>
          <AccordionTrigger>{String(item.props.title)}</AccordionTrigger>
          <AccordionContent className="flex flex-col gap-3">{kids(item.props.children).map(renderChild)}</AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
