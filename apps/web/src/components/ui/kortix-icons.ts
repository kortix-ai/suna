/**
 * Kortix brand icon layer.
 *
 * All icon imports in feature code should flow through this file instead of
 * importing from `lucide-react` directly. Benefits:
 *
 *   1. Single-line icon library swap (lucide → geist / tabler / iconoir / …)
 *   2. Stable Kortix-semantic names (`IconStatus` not `CircleDot`)
 *   3. Enforces a small curated set — pages can't drift into 40 random icons
 *
 * Rule for new pages: if the icon you want isn't exported here, add it here
 * and give it a purposeful name.
 */

export {
  // ── Navigation & layout ─────────────────────────────────────
  ChevronDown as IconChevronDown,
  X as IconClose,

  // ── Files & folders ─────────────────────────────────────────
  Terminal as IconTerminal,

  // ── CRUD & actions ──────────────────────────────────────────
  Plus as IconAdd,
  Minus as IconRemove,
  Trash2 as IconDelete,
  Pencil as IconEdit,
  Copy as IconCopy,
  Check as IconCheck,
  Loader2 as IconLoader,
  RotateCw as IconRefresh,
  ExternalLink as IconExternal,
  Link2 as IconLink,

  // ── Status / lifecycle ──────────────────────────────────────
  Clock as IconClock,
  Square as IconStop,
  Inbox as IconInbox,

  // ── Apps & deploy ───────────────────────────────────────────
  AppWindow as IconApp,
  Rocket as IconDeploy,
} from 'lucide-react';

export type { LucideIcon as Icon } from 'lucide-react';
