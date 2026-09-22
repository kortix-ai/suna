import {
  ArrowCircleDownIcon,
  ArrowsLeftRightIcon,
  CalendarIcon,
  ClockIcon,
  CodeIcon,
  CompassIcon,
  CpuIcon,
  FolderIcon,
  FolderOpenIcon,
  GearSixIcon,
  GitBranchIcon,
  GitForkIcon,
  GitPullRequestIcon,
  GlobeIcon,
  KeyIcon,
  LinkIcon,
  PulseIcon,
  PuzzlePieceIcon,
  SparkleIcon,
  SquaresFourIcon,
  TerminalIcon,
  UsersIcon,
  QuestionIcon,
  type AppIcon,
  SealCheckIcon,
} from '@/lib/icons';

/**
 * Icon for each page tab in `PAGE_TABS` (`@/stores/tab-store`). It lives
 * outside the store so the store never imports React components.
 */
const PAGE_TAB_ICONS: Record<string, AppIcon> = {
  'page:files': FolderOpenIcon,
  'page:terminal': TerminalIcon,
  'page:memory': CpuIcon,
  'page:workspace': SquaresFourIcon,
  'page:secrets': KeyIcon,
  'page:ssh': LinkIcon,
  'page:api': CodeIcon,
  'page:triggers': CalendarIcon,
  'page:tunnel': ArrowsLeftRightIcon,
  'page:connections': GitBranchIcon,
  'page:running-services': PulseIcon,
  'page:browser': CompassIcon,
  'page:agent-browser': GlobeIcon,
  'page:updates': ArrowCircleDownIcon,
  'page:projects': FolderIcon,
  'page:agents': CpuIcon,
  'page:skills': SparkleIcon,
  'page:connectors': PuzzlePieceIcon,
  'page:secrets-nav': KeyIcon,
  'page:schedules': ClockIcon,
  'page:webhooks': GitForkIcon,
  'page:changes': GitPullRequestIcon,
  'page:review': SealCheckIcon,
  'page:files-nav': FolderIcon,
  'page:dev': TerminalIcon,
  'page:members': UsersIcon,
  'page:settings': GearSixIcon,
};

/** The icon for a page tab id, or a question mark for an unknown id. */
export function getPageTabIcon(pageId: string): AppIcon {
  return PAGE_TAB_ICONS[pageId] ?? QuestionIcon;
}
