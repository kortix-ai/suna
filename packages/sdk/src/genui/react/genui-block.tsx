import {
  Component,
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ComponentType,
  type ReactNode,
} from 'react';

import { genuiResultToMarkdown } from '../markdown';
import {
  createGenuiParser,
  genuiNodeToMarkdown,
  GENUI_CUT_OFF_NOTE,
  GENUI_SCHEMA_VERSION,
  GENUI_UNSUPPORTED_NOTE,
  type GenuiNode,
  type GenuiParser,
  type GenuiParseResult,
} from '../index';

/** Props every host component receives. `props` is already validated against the catalog. */
export interface GenuiComponentProps {
  node: GenuiNode;
  props: Record<string, any>;
  /** Render a child node (from a slot prop) through the same component map. */
  renderChild: (node: GenuiNode) => ReactNode;
  /** The block is still streaming. */
  streaming: boolean;
}

/** Component name → host component. A missing entry renders that node's markdown. */
export type GenuiComponentMap = Readonly<Partial<Record<string, ComponentType<GenuiComponentProps>>>>;

export type GenuiOutcome = 'rendered' | 'fallback' | 'parse_error' | 'render_error' | 'unsupported';

export interface GenuiBlockEvent {
  outcome: GenuiOutcome;
  /** Component names in the rendered tree, sorted, unique. Never content. */
  components: string[];
  /** Milliseconds from mount to the first rendered root, when one rendered. */
  msToFirstPaint: number | null;
  issueCount: number;
}

export interface GenuiBlockProps {
  /** The fence body so far. */
  code: string;
  /** Schema version from the fence tag (`genuiVersionOf`). */
  version?: number;
  streaming: boolean;
  components: GenuiComponentMap;
  /**
   * The host's markdown renderer, for fallbacks.
   * Pass a stable function (module constant or useCallback): a new function re-renders the block's markdown parts and node views.
   */
  renderMarkdown: (markdown: string) => ReactNode;
  /** A node the model has not finished. Default: nothing (no skeletons). */
  renderPending?: (node: GenuiNode) => ReactNode;
  /** false: the viewer turned generative UI off. The block renders as markdown. */
  enabled?: boolean;
  /** Fires once per block, when it stops streaming. */
  onSettled?: (event: GenuiBlockEvent) => void;
}

interface RenderContextValue {
  components: GenuiComponentMap;
  renderMarkdown: (markdown: string) => ReactNode;
  renderPending: (node: GenuiNode) => ReactNode;
  streaming: boolean;
}

const RenderContext = createContext<RenderContextValue | null>(null);
const renderNothing = () => null;

/** Memoized on node identity. The core parser keeps unchanged nodes identical across ticks. */
const GenuiNodeView = memo(function NodeView({ node }: { node: GenuiNode }) {
  // The inner function has its own name: inside it, `GenuiNodeView` must resolve to the memoized outer const.
  const context = useContext(RenderContext)!;
  const renderChild = useCallback((child: GenuiNode) => <GenuiNodeView key={child.id} node={child} />, []);
  if (node.partial) return <>{context.renderPending(node)}</>;
  const HostComponent = context.components[node.type];
  if (!HostComponent) return <>{context.renderMarkdown(genuiNodeToMarkdown(node))}</>;
  return <HostComponent node={node} props={node.props} renderChild={renderChild} streaming={context.streaming} />;
});

class BlockBoundary extends Component<
  { fallback: ReactNode; onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onError();
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function collectTypes(node: GenuiNode | null, into: Set<string>): Set<string> {
  if (!node) return into;
  into.add(node.type);
  for (const value of Object.values(node.props)) {
    if (Array.isArray(value)) for (const child of value) if (child && typeof child === 'object' && 'type' in child) collectTypes(child as GenuiNode, into);
  }
  return into;
}

/**
 * The block as markdown, from the block's own incremental parse result. Memoized on the result,
 * which the parser keeps identical for identical input. While streaming, the unfinished statement
 * is left out and no cut-off note shows.
 */
const BlockFallback = memo(function BlockFallback({
  result,
  renderMarkdown,
}: {
  result: GenuiParseResult;
  renderMarkdown: (markdown: string) => ReactNode;
}) {
  const markdown = useMemo(() => genuiResultToMarkdown(result), [result]);
  return <>{markdown ? renderMarkdown(markdown) : null}</>;
});

/** Parse the block on every render with one parser per block; same input returns the same result. */
export function useGenuiParse(code: string, version: number, streaming: boolean): GenuiParseResult {
  const parserRef = useRef<{ version: number; parser: GenuiParser } | null>(null);
  if (!parserRef.current || parserRef.current.version !== version) {
    parserRef.current = { version, parser: createGenuiParser(version) };
  }
  return parserRef.current.parser.update(code, streaming);
}

/** Render one generative-UI block. Never throws, never shows OpenUI source. */
export function GenuiBlock({
  code,
  version = GENUI_SCHEMA_VERSION,
  streaming,
  components,
  renderMarkdown,
  renderPending = renderNothing,
  enabled = true,
  onSettled,
}: GenuiBlockProps) {
  // A disabled block parses too: its markdown comes from the same incremental result.
  const result = useGenuiParse(code, version, streaming);
  const mountedAt = useRef(performance.now());
  const firstPaint = useRef<number | null>(null);
  const renderError = useRef(false);
  if (enabled && result.root && firstPaint.current === null) firstPaint.current = performance.now() - mountedAt.current;

  const context = useMemo<RenderContextValue>(
    () => ({ components, renderMarkdown, renderPending, streaming }),
    [components, renderMarkdown, renderPending, streaming],
  );

  const unsupported = version !== GENUI_SCHEMA_VERSION;
  useEffect(() => {
    if (streaming || !onSettled) return;
    const outcome: GenuiOutcome = unsupported
      ? 'unsupported'
      : !enabled
        ? 'fallback'
        : renderError.current
          ? 'render_error'
          : result.root
            ? 'rendered'
            : 'parse_error';
    onSettled({
      outcome,
      // A disabled block renders no UI: it reports no components and no issues.
      components: enabled ? [...collectTypes(result.root, new Set())].sort() : [],
      msToFirstPaint: firstPaint.current === null ? null : Math.round(firstPaint.current),
      issueCount: enabled ? result.issues.length : 0,
    });
    // Fires when streaming settles; later re-renders of a settled block do not re-fire.
  }, [streaming]); // eslint-disable-line react-hooks/exhaustive-deps

  if (unsupported) return <>{renderMarkdown(`*${GENUI_UNSUPPORTED_NOTE}*`)}</>;
  if (!enabled) return <BlockFallback result={result} renderMarkdown={renderMarkdown} />;
  if (!result.root) return streaming ? null : <BlockFallback result={result} renderMarkdown={renderMarkdown} />;

  return (
    <BlockBoundary
      // A throw while streaming gets one fresh try when the stream settles.
      // Settling remounts the node views once: host state such as an active tab resets.
      key={streaming ? 'live' : 'settled'}
      fallback={<BlockFallback result={result} renderMarkdown={renderMarkdown} />}
      onError={() => (renderError.current = !streaming)}
    >
      <RenderContext.Provider value={context}>
        <GenuiNodeView node={result.root} />
      </RenderContext.Provider>
      {!streaming && result.issues.some((issue) => issue.code === 'cut-off') ? renderMarkdown(`*${GENUI_CUT_OFF_NOTE}*`) : null}
    </BlockBoundary>
  );
}
