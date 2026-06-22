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

export { Plus as IconAdd, Microchip as IconAgent, DangerCircle as IconAlert, ArrowUpRight as IconArrowUpRight, ArrowLeft as IconBack, CircleDashed as IconBacklog, Sparkles as IconBot, Calendar as IconCalendar, XCircle as IconCancelled, Check as IconCheck, ChevronDown as IconChevronDown, ChevronLeft as IconChevronLeft, ChevronRight as IconChevronRight, ChevronUp as IconChevronUp, ChevronsUpDown as IconChevronsUpDown, ClockCircle as IconClock, X as IconClose, Code as IconCode, Chat as IconComment, Copy as IconCopy, TrashSolid as IconDelete, CheckCircle as IconDone, Download as IconDownload, Pencil as IconEdit, ExternalLink as IconExternal, DangerOctagon as IconFailed, File as IconFile, FileText as IconFileText, Filter as IconFilter, Folder as IconFolder, Folder as IconFolderOpen, ArrowRight as IconForward, Grid as IconGrid, Hash as IconHash, Record as IconInProgress, CircleDashed as IconInReview, Inbox as IconInbox, Info as IconInfo, QuestionCircle as IconInfoNeeded, UserPlus as IconInvite, Link as IconLink, List as IconList, Spinner as IconLoader, Mail as IconMail, Menu as IconMenu, Message as IconMessage, Dots as IconMore, DotsVertical as IconMoreVertical, Bell as IconNotification, Pause as IconPause, Play as IconPlay, Folder as IconProject, Refresh as IconRefresh, Minus as IconRemove, Search as IconSearch, Send as IconSend, CogOneSolid as IconSettings, ArrowUpDown as IconSort, Star as IconStar, Square as IconStop, Tag as IconTag, Terminal as IconTerminal, Circle as IconTodo, Zap as IconTrigger, Star as IconUnstar, Upload as IconUpload, User as IconUser, UsersSolid as IconUsers, DangerTriangle as IconWarning, PanelTop as IconApp, Rocket as IconDeploy } from '@mynaui/icons-react';


export type { Icon } from '@mynaui/icons-react';
