import { Button } from './button';
import Loading from './loading';
import { Close } from '../icons/close';
import { cn } from '../lib/utils';
import { WarningCircleIcon } from '@phosphor-icons/react';
import * as React from 'react';
import { toast } from 'sonner';

/** The toast host. Mount it once at the app root; every toast below renders into it. */
export { Toaster } from 'sonner';

/** A text-link action under the toast body. A click dismisses the toast first. */
export type ToastAction = { label: string; onClick: () => void };

type ToastOptions = {
  description?: string;
  duration?: number;
  id?: string | number;
  position?:
    'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'top-center' | 'bottom-center';
  /** Text links under the body, joined by a dot. */
  actions?: ToastAction[];
  /**
   * The thing the toast is about. Its name is the line under the title; its
   * icon (a trigger's clock, say) becomes the leading tile, with the status
   * glyph as a badge on its corner.
   */
  entity?: { icon?: React.ReactNode; label: string };
  /** Muted text after the actions, on the same line. */
  meta?: string;
  /** One line, no close button, as wide as its text. For "Copied"-style confirmations. */
  compact?: boolean;
  /** Legacy: a free-form node under the body. Prefer `actions`. */
  button?: React.ReactNode;
};

type LoadingToastOptions<T = unknown> = ToastOptions & {
  success?: string | ((data: T) => string);
  error?: string | ((error: unknown) => string);
  showErrorToast?: boolean;
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'An error occurred';
};

const DEFAULT_DURATION = 3000;
const UNDO_DURATION = 5000;
const DEFAULT_POSITION = 'bottom-right';

/** The card every toast sits on: one shape, the smooth `ring-sm` shadow, no border. */
const CARD = 'bg-background text-foreground smooth-shadow-ring-sm rounded-lg';

/**
 * Build the data object for `toast.custom`.
 *
 * sonner hands the generated id to our render callback (so the close button can
 * call `toast.dismiss(id)`), but it then spreads `data` over that id. Passing
 * `id: undefined` clobbers it and sonner mints a *different* real id, leaving the
 * close button pointing at a toast that no longer matches — so it never dismisses.
 * Only include `id` when it is actually defined.
 */
const toastData = (
  options: Pick<ToastOptions, 'id' | 'position'> | undefined,
  duration: number,
  isMobile: boolean,
): Parameters<typeof toast.custom>[1] => ({
  ...(options?.id != null ? { id: options.id } : {}),
  duration,
  position: isMobile ? 'top-center' : options?.position || DEFAULT_POSITION,
});

export type ToastVariant = 'success' | 'progress' | 'error' | 'info' | 'warning';

/** A 16px filled status disc. The mark inside is drawn in the card's own color. */
function Disc({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    // overflow-visible: the disc fills the box edge to edge, and size-4 is a
    // fractional 14.72px, so a clipping svg shaves its antialiased rim.
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cn('size-4 shrink-0 overflow-visible', className)}
    >
      <circle cx="8" cy="8" r="8" fill="currentColor" />
      <g className="text-background" stroke="currentColor" fill="currentColor">
        {children}
      </g>
    </svg>
  );
}

/** The leading glyph of each variant. `loadingToast` uses `progress`. */
export const toastIcon = (variant: ToastVariant): React.ReactNode => {
  switch (variant) {
    case 'success':
      return (
        <Disc className="text-kortix-green">
          <path
            d="M4.8 8.2l2.1 2.1 4.3-4.6"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Disc>
      );
    case 'progress':
      return <Loading variant="spokes" className="size-4 shrink-0 overflow-visible" />;
    case 'error':
      return (
        <Disc className="text-kortix-red">
          <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" strokeWidth="1.6" strokeLinecap="round" />
        </Disc>
      );
    case 'info':
      return (
        <Disc className="text-foreground">
          <circle cx="8" cy="4.9" r="0.95" stroke="none" />
          <path d="M8 7.4v4" strokeWidth="1.6" strokeLinecap="round" />
        </Disc>
      );
    case 'warning':
      return (
        <WarningCircleIcon
          weight="fill"
          aria-hidden="true"
          className="text-kortix-orange size-4 shrink-0 overflow-visible"
        />
      );
  }
};

/** The small muted × every dismissible toast carries. */
export function ToastClose({ onDismiss, className }: { onDismiss: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onDismiss}
      aria-label="Close notification"
      className={cn(
        'text-muted-foreground hover:text-foreground flex size-5 shrink-0 items-center justify-center rounded-sm transition-colors',
        className,
      )}
    >
      <Close className="size-3" aria-hidden="true" />
    </button>
  );
}

/** Text links joined by a dot, then optional muted meta. */
function ToastActions({
  actions,
  meta,
  onDismiss,
}: {
  actions?: ToastAction[];
  meta?: string;
  onDismiss: () => void;
}) {
  if (!actions?.length && !meta) return null;
  // xs ghost buttons, pulled left by their own padding so the first label
  // lines up with the title.
  return (
    <div className="-ml-2.5 flex items-center gap-0.5 text-xs leading-5">
      {(actions ?? []).map((action) => (
        <Button
          key={action.label}
          type="button"
          variant="blue-ghost"
          size="xs"
          className="hover:bg-kortix-blue/15 h-5.5 rounded-sm px-2 text-xs font-medium"
          onClick={() => {
            onDismiss();
            action.onClick();
          }}
        >
          {action.label}
        </Button>
      ))}
      {meta && <span className="text-muted-foreground px-2.5">{meta}</span>}
    </div>
  );
}

/** The status colour the badge reflects onto the subject icon. `progress` reflects nothing. */
const REFLECTION_TONE: Partial<Record<ToastVariant, string>> = {
  success: 'text-kortix-green',
  error: 'text-kortix-red',
  warning: 'text-kortix-orange',
  info: 'text-foreground',
};

/**
 * Where the badge's colour reaches on the icon. Paper board "04 · Badge glow",
 * V1 rim reflection, pushed further on request: the colour holds solid to
 * 7.2px from the badge's centre and fades out by 16px, so it climbs the
 * clock's right side and runs along its bottom. Centred on the badge: an 11px badge at -right-0.75 /
 * -bottom-0.75 sits on the icon's diagonal at 85% / 85%, the board's 18.5/24.
 * The badge is 0.72x the clock's radius, as on the board, so it leaves the
 * rim it lights visible.
 */
export const REFLECTION_MASK = 'radial-gradient(circle 16px at 85% 85%, #000 45%, transparent 100%)';

/**
 * The subject's icon, bare, with the status glyph badged on its bottom-right
 * corner. The icon is drawn twice: muted, then in the status colour under a
 * radial mask centred on the badge, so its rim picks up the badge's colour
 * where they meet and fades back to grey (V1 rim reflection).
 */
function EntityTile({
  icon,
  status,
  variant,
}: {
  icon: React.ReactNode;
  status: React.ReactNode;
  variant?: ToastVariant;
}) {
  const tone = variant ? REFLECTION_TONE[variant] : undefined;
  return (
    <div className="relative mt-0.5 size-5 shrink-0">
      <div className="text-muted-foreground flex size-5 items-center justify-center [&_svg]:size-5">
        {icon}
      </div>
      {tone && (
        <div
          aria-hidden="true"
          className={cn('absolute inset-0 flex size-5 items-center justify-center [&_svg]:size-5', tone)}
          style={{ maskImage: REFLECTION_MASK, WebkitMaskImage: REFLECTION_MASK }}
        >
          {icon}
        </div>
      )}
      <span className="bg-background absolute -right-0.75 -bottom-0.75 flex size-3 items-center justify-center rounded-full [&_svg]:size-2.5">
        {status}
      </span>
    </div>
  );
}

/**
 * The toast card itself. `renderToast` mounts it through sonner; the session
 * notifications mount it through `customToast`.
 */
export function ToastCard({
  message,
  icon,
  variant,
  options,
  onDismiss,
}: {
  message: string;
  icon: React.ReactNode;
  /** The status, for the colour an entity icon reflects from its badge. */
  variant?: ToastVariant;
  options?: Pick<ToastOptions, 'description' | 'button' | 'actions' | 'entity' | 'meta' | 'compact'>;
  onDismiss: () => void;
}) {
  if (options?.compact) {
    return (
      <div className={cn(CARD, 'flex w-fit items-center gap-2 px-3 py-2')}>
        {icon}
        <span className="text-xs leading-5 font-medium">{message}</span>
      </div>
    );
  }

  return (
    <div className={cn(CARD, 'flex w-full items-start gap-2.5 py-3 pr-2.5 pl-4 sm:w-[var(--width)]')}>
      {options?.entity?.icon ? (
        <EntityTile icon={options.entity.icon} status={icon} variant={variant} />
      ) : (
        <div className="flex h-5 w-4 shrink-0 items-center justify-center">{icon}</div>
      )}
      <div className="flex min-w-0 grow flex-col gap-1.5">
        {/* Title, then the subject it is about, then the detail. */}
        <p className="text-xs leading-5 font-medium">{message}</p>
        {options?.entity && (
          <p className="-mt-1 truncate text-xs leading-5">{options.entity.label}</p>
        )}
        {options?.description && (
          <p
            className={cn(
              'text-muted-foreground text-xs leading-5',
              // Without an entity line it reads as the title's second line.
              !options.entity && '-mt-1',
            )}
          >
            {options.description}
          </p>
        )}
        <ToastActions actions={options?.actions} meta={options?.meta} onDismiss={onDismiss} />
        {options?.button && <div className="self-start">{options.button}</div>}
      </div>
      <ToastClose onDismiss={onDismiss} />
    </div>
  );
}

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/**
 * The one-line undo toast: icon, message, an Undo key and ×. While it is on
 * screen, ⌘Z / Ctrl+Z outside a text field undoes too.
 */
function UndoToastCard({
  message,
  icon,
  undoLabel,
  onUndo,
  onDismiss,
}: {
  message: string;
  icon?: React.ReactNode;
  undoLabel: string;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const undo = () => {
    onDismiss();
    onUndo();
  };
  const undoRef = React.useRef(undo);
  React.useEffect(() => {
    undoRef.current = undo;
  });

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'z' || event.shiftKey) return;
      if (!(event.metaKey || event.ctrlKey) || isEditable(event.target)) return;
      event.preventDefault();
      undoRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The same card and text-link action as every other toast ("Open session").
  return (
    <ToastCard
      message={message}
      icon={icon ? <span className="text-muted-foreground flex">{icon}</span> : null}
      options={{ actions: [{ label: undoLabel, onClick: onUndo }] }}
      onDismiss={onDismiss}
    />
  );
}

/**
 * Render one toast and return the id `toast.custom` minted.
 *
 * The six factories share this one DOM shape; only the leading icon and the
 * resolved duration differ. `isMobile` is read here so every factory gets the
 * same bottom-right-to-top-center switch. The duration arrives already
 * resolved, so each factory keeps its own `||` / `??` rule.
 */
const renderToast = (
  message: string,
  variant: ToastVariant,
  options: ToastOptions | undefined,
  duration: number,
): string | number => {
  const isMobile = window.innerWidth <= 768;

  return toast.custom(
    (t) => (
      <ToastCard
        message={message}
        icon={toastIcon(variant)}
        variant={variant}
        options={options}
        onDismiss={() => toast.dismiss(t)}
      />
    ),
    toastData(options, duration, isMobile),
  );
};

export const successToast = (message: string, options?: ToastOptions) => {
  renderToast(message, 'success', options, options?.duration || DEFAULT_DURATION);
};

/** Show or update a loading toast; pass `id` to update an existing toast in place. */
export const progressToast = (message: string, options?: ToastOptions): string | number => {
  return renderToast(message, 'progress', options, options?.duration ?? Infinity);
};

export const loadingToast = <T,>(
  message: string,
  promiseInput: Promise<T> | (() => Promise<T>),
  options?: LoadingToastOptions<T>,
): Promise<T> => {
  const promise = typeof promiseInput === 'function' ? promiseInput() : promiseInput;

  const toastId = renderToast(message, 'progress', options, Infinity);

  return promise.then(
    (data) => {
      toast.dismiss(toastId);
      const successMessage =
        typeof options?.success === 'function'
          ? options.success(data)
          : (options?.success ?? 'Completed');
      successToast(successMessage, options);
      return data;
    },
    (error) => {
      toast.dismiss(toastId);
      if (options?.showErrorToast) {
        const errorMessage =
          typeof options?.error === 'function'
            ? options.error(error)
            : (options?.error ?? getErrorMessage(error));
        errorToast(errorMessage, options);
      }
      throw error;
    },
  );
};

let isSilentErrorMessage: (message: string) => boolean = () => false;

/**
 * Sets the host's rule for error messages that `errorToast` drops without a
 * toast (apps/web drops request-deadline noise). Default: none is dropped.
 * Call it once at module load, before the first toast.
 */
export function setSilentErrorToastFilter(filter: (message: string) => boolean): void {
  isSilentErrorMessage = filter;
}

export const errorToast = (message: string, options?: ToastOptions) => {
  if (isSilentErrorMessage(message)) return;

  renderToast(message, 'error', options, options?.duration || DEFAULT_DURATION);
};

export const infoToast = (message: string, options?: ToastOptions) => {
  renderToast(message, 'info', options, options?.duration || DEFAULT_DURATION);
};

export const warningToast = (message: string, options?: ToastOptions) => {
  renderToast(message, 'warning', options, options?.duration || DEFAULT_DURATION);
};

/**
 * One-line toast with an Undo key. `undoLabel` is the caller's translated
 * "Undo"; `icon` is an optional muted glyph naming what happened.
 */
export const undoToast = (
  message: string,
  options: Pick<ToastOptions, 'id' | 'position' | 'duration'> & {
    undoLabel: string;
    onUndo: () => void;
    icon?: React.ReactNode;
  },
): string | number => {
  const isMobile = window.innerWidth <= 768;
  return toast.custom(
    (t) => (
      <UndoToastCard
        message={message}
        icon={options.icon}
        undoLabel={options.undoLabel}
        onUndo={options.onUndo}
        onDismiss={() => toast.dismiss(t)}
      />
    ),
    toastData(options, options.duration ?? UNDO_DURATION, isMobile),
  );
};

/**
 * Mount a caller-drawn card through the same toast surface — for notifications
 * whose shape is their own (the session cards). `render` gets the dismiss.
 */
export const customToast = (
  render: (dismiss: () => void) => React.ReactElement,
  options: Pick<ToastOptions, 'id' | 'position' | 'duration'> & { onClose?: () => void },
): string | number => {
  const isMobile = window.innerWidth <= 768;
  return toast.custom((t) => render(() => toast.dismiss(t)), {
    ...toastData(options, options.duration ?? DEFAULT_DURATION, isMobile),
    ...(options.onClose ? { onDismiss: options.onClose, onAutoClose: options.onClose } : {}),
  });
};

/**
 * Dismiss a toast by the `id` it was created with.
 *
 * Exists so feature code can retract a PERSISTENT toast when the condition it
 * reports goes away — a `duration: Infinity` notice with an action button has to
 * be revocable, or it outlives the problem and offers to fix something already
 * fixed. Wrapped here rather than importing sonner in a feature: this module is
 * the toast surface.
 */
export const dismissToast = (id: string | number) => {
  toast.dismiss(id);
};
