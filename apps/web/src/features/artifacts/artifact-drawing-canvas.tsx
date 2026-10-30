'use client';

import { Button } from '@kortix/ui/button';
import Hint from '@kortix/ui/hint';
import Loading from '@kortix/ui/loading';
import {
  ArrowCounterClockwiseIcon,
  ArrowUpRightIcon,
  ChatCircleIcon,
  PencilSimpleIcon,
  RectangleIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import {
  addDrawingStroke,
  appendDrawingPoint,
  canAddDrawingStroke,
  drawingStrokeWidth,
  drawingViewportRect,
  finishDrawingStroke,
  type DrawingPoint,
  type DrawingStroke,
} from './artifact-drawing';

export type DrawingLabels = {
  canvas: string;
  pen: string;
  arrow: string;
  rectangle: string;
  black: string;
  red: string;
  blue: string;
  undo: string;
  finish: string;
  cancel: string;
  pageChanged: string;
  limit: string;
};
const tools = [
  { tool: 'pen', icon: PencilSimpleIcon },
  { tool: 'arrow', icon: ArrowUpRightIcon },
  { tool: 'rectangle', icon: RectangleIcon },
] as const;
const colors = ['black', 'red', 'blue'] as const;

export function DrawingStrokeShape({ stroke }: { stroke: DrawingStroke }) {
  const first = stroke.points[0]!;
  const last = stroke.points.at(-1)!;
  const attributes = {
    stroke: stroke.color,
    strokeWidth: stroke.width,
    fill: 'none',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  if (stroke.tool === 'rectangle')
    return (
      <rect
        {...attributes}
        x={Math.min(first.x, last.x)}
        y={Math.min(first.y, last.y)}
        width={Math.abs(last.x - first.x)}
        height={Math.abs(last.y - first.y)}
      />
    );
  if (stroke.tool === 'arrow') {
    const angle = Math.atan2(last.y - first.y, last.x - first.x);
    const size = Math.min(stroke.width * 4, Math.hypot(last.x - first.x, last.y - first.y) / 3);
    const head = [
      {
        x: last.x - size * Math.cos(angle - Math.PI / 6),
        y: last.y - size * Math.sin(angle - Math.PI / 6),
      },
      last,
      {
        x: last.x - size * Math.cos(angle + Math.PI / 6),
        y: last.y - size * Math.sin(angle + Math.PI / 6),
      },
    ];
    return (
      <g>
        <line {...attributes} x1={first.x} y1={first.y} x2={last.x} y2={last.y} />
        <polyline {...attributes} points={head.map((point) => `${point.x},${point.y}`).join(' ')} />
      </g>
    );
  }
  if (stroke.points.every((point) => point.x === first.x && point.y === first.y))
    return <circle cx={first.x} cy={first.y} r={stroke.width / 2} fill={stroke.color} />;
  return (
    <polyline
      {...attributes}
      points={stroke.points.map((point) => `${point.x},${point.y}`).join(' ')}
    />
  );
}

export function ArtifactDrawingCanvas({
  viewport,
  busy,
  stale = false,
  labels,
  onFinish,
  onCancel,
}: {
  viewport: { width: number; height: number };
  busy: boolean;
  stale?: boolean;
  labels: DrawingLabels;
  onFinish: (strokes: DrawingStroke[]) => void;
  onCancel: () => void;
}) {
  const [tool, setTool] = useState<DrawingStroke['tool']>('pen');
  const [color, setColor] = useState<DrawingStroke['color']>('black');
  const [strokes, setStrokes] = useState<DrawingStroke[]>([]);
  const [active, setActive] = useState<DrawingStroke | null>(null);
  const gesture = useRef<{ pointer: number; stroke: DrawingStroke } | null>(null);
  const canvas = useRef<SVGSVGElement>(null);
  const region = drawingViewportRect(strokes, viewport);
  const previewRegion = active ? drawingViewportRect([...strokes, active], viewport) : region;
  const preview = (stroke: DrawingStroke) =>
    previewRegion
      ? { ...stroke, width: drawingStrokeWidth(stroke.width, previewRegion.width) }
      : stroke;
  const limited = !canAddDrawingStroke(strokes);
  useEffect(() => {
    canvas.current?.focus({ preventScroll: true });
  }, []);
  const point = (event: PointerEvent<SVGSVGElement>): DrawingPoint | null => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (
      !bounds.width ||
      !bounds.height ||
      Math.abs(event.currentTarget.clientWidth - viewport.width) > 1
    )
      return null;
    return {
      x: Math.max(
        0,
        Math.min(viewport.width, ((event.clientX - bounds.x) * viewport.width) / bounds.width),
      ),
      y: Math.max(
        0,
        Math.min(viewport.height, ((event.clientY - bounds.y) * viewport.height) / bounds.height),
      ),
    };
  };
  const update = (event: PointerEvent<SVGSVGElement>) => {
    if (busy || stale) return;
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    const next = point(event);
    if (!next) return;
    const points =
      current.stroke.tool === 'pen'
        ? appendDrawingPoint(current.stroke.points, next)
        : [current.stroke.points[0]!, next];
    current.stroke = { ...current.stroke, points };
    setActive(current.stroke);
  };
  return (
    <div
      className="pointer-events-none absolute inset-0"
      data-artifact-drawing
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <svg
        ref={canvas}
        className="pointer-events-auto absolute inset-0 size-full cursor-crosshair touch-none outline-none"
        viewBox={`0 0 ${viewport.width} ${viewport.height}`}
        preserveAspectRatio="none"
        tabIndex={0}
        role="img"
        aria-label={labels.canvas}
        aria-busy={busy}
        onPointerDown={(event) => {
          if (busy || stale || limited || event.button !== 0 || gesture.current) return;
          const start = point(event);
          if (!start) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          gesture.current = {
            pointer: event.pointerId,
            stroke: { tool, color, width: 2, points: [start] },
          };
          setActive(gesture.current.stroke);
        }}
        onPointerMove={update}
        onPointerUp={(event) => {
          if (!gesture.current || gesture.current.pointer !== event.pointerId) return;
          if (busy || stale) {
            gesture.current = null;
            setActive(null);
            return;
          }
          update(event);
          const current = gesture.current.stroke;
          const complete = finishDrawingStroke(current.tool, current.color, current.points);
          gesture.current = null;
          setActive(null);
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          if (complete) setStrokes((previous) => addDrawingStroke(previous, complete));
        }}
        onPointerCancel={(event) => {
          if (gesture.current?.pointer !== event.pointerId) return;
          gesture.current = null;
          setActive(null);
        }}
        onLostPointerCapture={(event) => {
          if (gesture.current?.pointer !== event.pointerId) return;
          gesture.current = null;
          setActive(null);
        }}
      >
        {strokes.map((stroke, index) => (
          <DrawingStrokeShape key={index} stroke={preview(stroke)} />
        ))}
        {active ? <DrawingStrokeShape stroke={preview(active)} /> : null}
      </svg>
      <div className="bg-popover border-border pointer-events-auto absolute inset-x-3 bottom-3 flex flex-wrap items-center gap-1 rounded-md border p-1 shadow-sm">
        {tools.map(({ tool: value, icon: Icon }) => (
          <Hint key={value} label={labels[value]}>
            <Button
              size="icon-sm"
              variant={tool === value ? 'secondary' : 'ghost'}
              aria-label={labels[value]}
              aria-pressed={tool === value}
              disabled={busy}
              onClick={() => setTool(value)}
            >
              <Icon className="size-4" aria-hidden />
            </Button>
          </Hint>
        ))}
        {colors.map((value) => (
          <Hint key={value} label={labels[value]}>
            <Button
              size="icon-sm"
              variant={color === value ? 'secondary' : 'ghost'}
              aria-label={labels[value]}
              aria-pressed={color === value}
              disabled={busy}
              onClick={() => setColor(value)}
            >
              <span
                className="border-border size-3 rounded-full border"
                style={{ backgroundColor: value }}
              />
            </Button>
          </Hint>
        ))}
        <Hint label={labels.undo}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={labels.undo}
            disabled={busy || !strokes.length}
            onClick={() => setStrokes((previous) => previous.slice(0, -1))}
          >
            <ArrowCounterClockwiseIcon className="size-4" aria-hidden />
          </Button>
        </Hint>
        <Hint label={labels.cancel}>
          <Button size="icon-sm" variant="ghost" aria-label={labels.cancel} onClick={onCancel}>
            <XIcon className="size-4" aria-hidden />
          </Button>
        </Hint>
        <Button
          size="sm"
          className="ml-auto"
          disabled={busy || stale || !!active || !region}
          onClick={() => onFinish(strokes)}
        >
          {busy ? (
            <Loading className="size-4" />
          ) : (
            <ChatCircleIcon className="size-4" aria-hidden />
          )}
          {labels.finish}
        </Button>
        {limited ? (
          <p className="text-muted-foreground w-full px-2 text-xs" role="status">
            {labels.limit}
          </p>
        ) : null}
        {stale || (strokes.length > 0 && !region) ? (
          <p className="text-muted-foreground w-full px-2 text-xs" role="status">
            {labels.pageChanged}
          </p>
        ) : null}
      </div>
    </div>
  );
}
