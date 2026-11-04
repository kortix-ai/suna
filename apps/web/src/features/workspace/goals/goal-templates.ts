import {
  BookOpenTextIcon,
  BugIcon,
  ChartBarIcon,
  ChatsCircleIcon,
  CheckCircleIcon,
  ClipboardTextIcon,
  CodeIcon,
  FileTextIcon,
  GaugeIcon,
  GitMergeIcon,
  GlobeIcon,
  KeyIcon,
  LightbulbIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  PaperPlaneTiltIcon,
  RocketLaunchIcon,
  ShieldCheckIcon,
  ShieldWarningIcon,
  StackIcon,
  TrayIcon,
  UserCheckIcon,
  UsersThreeIcon,
  type Icon,
} from '@phosphor-icons/react';

/** The tabs of the template gallery, in order. `featured` lists a cross-section of the others. */
export const GOAL_TEMPLATE_CATEGORIES = ['featured', 'engineering', 'reporting', 'security', 'support', 'operations'] as const;
export type GoalTemplateCategory = (typeof GOAL_TEMPLATE_CATEGORIES)[number];

/** The accent of a template's glyph. Only the glyph takes it: the words stay ink (brand color rule). */
export type GoalTemplateAccent = 'blue' | 'green' | 'orange' | 'purple' | 'red' | 'yellow';

/**
 * One starting point for a goal. The card says what the agent does first and
 * what proves the goal done (`steps`). Picking it puts `id`'s outcome text in
 * the composer for the person to finish; nothing starts until they send.
 * The copy lives in `goals.templates.<id>` (`title`, `description`,
 * `outcome`, `start`, `done`).
 */
export interface GoalTemplate {
  id: string;
  category: Exclude<GoalTemplateCategory, 'featured'>;
  featured: boolean;
  icon: Icon;
  accent: GoalTemplateAccent;
  /** The first step's glyph, then the glyph of the evidence that closes the goal. */
  steps: [Icon, Icon];
}

export const GOAL_TEMPLATES: readonly GoalTemplate[] = [
  { id: 'fixBug', category: 'engineering', featured: true, icon: BugIcon, accent: 'red', steps: [MagnifyingGlassIcon, GitMergeIcon] },
  { id: 'shipFeature', category: 'engineering', featured: true, icon: RocketLaunchIcon, accent: 'purple', steps: [ListChecksIcon, CheckCircleIcon] },
  { id: 'upgradeDependency', category: 'engineering', featured: false, icon: StackIcon, accent: 'blue', steps: [MagnifyingGlassIcon, GitMergeIcon] },
  { id: 'speedUpPage', category: 'engineering', featured: false, icon: GaugeIcon, accent: 'green', steps: [ChartBarIcon, CheckCircleIcon] },
  { id: 'weeklyWrap', category: 'reporting', featured: true, icon: ClipboardTextIcon, accent: 'yellow', steps: [MagnifyingGlassIcon, PaperPlaneTiltIcon] },
  { id: 'featureRequests', category: 'reporting', featured: true, icon: LightbulbIcon, accent: 'orange', steps: [StackIcon, FileTextIcon] },
  { id: 'metricsDashboard', category: 'reporting', featured: false, icon: ChartBarIcon, accent: 'blue', steps: [StackIcon, GlobeIcon] },
  { id: 'competitorBrief', category: 'reporting', featured: false, icon: MagnifyingGlassIcon, accent: 'purple', steps: [GlobeIcon, FileTextIcon] },
  { id: 'vulnerabilitySweep', category: 'security', featured: true, icon: ShieldWarningIcon, accent: 'red', steps: [MagnifyingGlassIcon, GitMergeIcon] },
  { id: 'rotateSecret', category: 'security', featured: false, icon: KeyIcon, accent: 'yellow', steps: [CodeIcon, CheckCircleIcon] },
  { id: 'accessReview', category: 'security', featured: false, icon: ShieldCheckIcon, accent: 'green', steps: [UsersThreeIcon, UserCheckIcon] },
  { id: 'supportBacklog', category: 'support', featured: true, icon: TrayIcon, accent: 'blue', steps: [ListChecksIcon, CheckCircleIcon] },
  { id: 'customerFollowUps', category: 'support', featured: false, icon: ChatsCircleIcon, accent: 'purple', steps: [ChatsCircleIcon, PaperPlaneTiltIcon] },
  { id: 'helpArticle', category: 'support', featured: false, icon: BookOpenTextIcon, accent: 'green', steps: [ChatsCircleIcon, GlobeIcon] },
  { id: 'docsSite', category: 'operations', featured: true, icon: GlobeIcon, accent: 'green', steps: [FileTextIcon, GlobeIcon] },
  { id: 'onboardHire', category: 'operations', featured: true, icon: UserCheckIcon, accent: 'orange', steps: [ListChecksIcon, CheckCircleIcon] },
  { id: 'projectHygiene', category: 'operations', featured: false, icon: ListChecksIcon, accent: 'blue', steps: [MagnifyingGlassIcon, UsersThreeIcon] },
  { id: 'vendorReview', category: 'operations', featured: false, icon: FileTextIcon, accent: 'yellow', steps: [MagnifyingGlassIcon, FileTextIcon] },
];

export function goalTemplatesIn(category: GoalTemplateCategory): GoalTemplate[] {
  return GOAL_TEMPLATES.filter((template) => (category === 'featured' ? template.featured : template.category === category));
}
