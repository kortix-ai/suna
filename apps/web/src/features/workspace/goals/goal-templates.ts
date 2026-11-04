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
  { id: 'fixBug', category: 'engineering', featured: true, icon: BugIcon, accent: 'red', steps: [MagnifyingGlassIcon, CodeIcon] },
  { id: 'shipFeature', category: 'engineering', featured: true, icon: RocketLaunchIcon, accent: 'purple', steps: [ListChecksIcon, CodeIcon] },
  { id: 'speedUpPage', category: 'engineering', featured: false, icon: GaugeIcon, accent: 'green', steps: [ChartBarIcon, FileTextIcon] },
  { id: 'upgradeDependency', category: 'engineering', featured: false, icon: StackIcon, accent: 'blue', steps: [MagnifyingGlassIcon, CodeIcon] },
  { id: 'weeklyWrap', category: 'reporting', featured: true, icon: ClipboardTextIcon, accent: 'yellow', steps: [MagnifyingGlassIcon, FileTextIcon] },
  { id: 'featureRequests', category: 'reporting', featured: true, icon: LightbulbIcon, accent: 'orange', steps: [StackIcon, FileTextIcon] },
  { id: 'competitorBrief', category: 'reporting', featured: false, icon: MagnifyingGlassIcon, accent: 'purple', steps: [GlobeIcon, FileTextIcon] },
  { id: 'metricsDashboard', category: 'reporting', featured: false, icon: ChartBarIcon, accent: 'blue', steps: [StackIcon, GlobeIcon] },
  { id: 'vulnerabilitySweep', category: 'security', featured: true, icon: ShieldWarningIcon, accent: 'red', steps: [MagnifyingGlassIcon, CodeIcon] },
  { id: 'scanSecrets', category: 'security', featured: true, icon: KeyIcon, accent: 'yellow', steps: [MagnifyingGlassIcon, FileTextIcon] },
  { id: 'accessReview', category: 'security', featured: false, icon: ShieldCheckIcon, accent: 'green', steps: [UsersThreeIcon, FileTextIcon] },
  { id: 'reviewWorkflow', category: 'security', featured: false, icon: CodeIcon, accent: 'purple', steps: [MagnifyingGlassIcon, FileTextIcon] },
  { id: 'supportBacklog', category: 'support', featured: true, icon: TrayIcon, accent: 'blue', steps: [ChatsCircleIcon, FileTextIcon] },
  { id: 'helpArticle', category: 'support', featured: false, icon: BookOpenTextIcon, accent: 'green', steps: [ChatsCircleIcon, FileTextIcon] },
  { id: 'customerFollowUps', category: 'support', featured: false, icon: ChatsCircleIcon, accent: 'purple', steps: [ChatsCircleIcon, PaperPlaneTiltIcon] },
  { id: 'summarizeEscalation', category: 'support', featured: false, icon: ClipboardTextIcon, accent: 'orange', steps: [MagnifyingGlassIcon, FileTextIcon] },
  { id: 'docsSite', category: 'operations', featured: true, icon: GlobeIcon, accent: 'green', steps: [FileTextIcon, GlobeIcon] },
  { id: 'onboardHire', category: 'operations', featured: false, icon: UserCheckIcon, accent: 'orange', steps: [ListChecksIcon, FileTextIcon] },
  { id: 'projectHygiene', category: 'operations', featured: false, icon: ListChecksIcon, accent: 'blue', steps: [MagnifyingGlassIcon, CheckCircleIcon] },
  { id: 'vendorReview', category: 'operations', featured: false, icon: FileTextIcon, accent: 'yellow', steps: [MagnifyingGlassIcon, FileTextIcon] },
];

export function goalTemplatesIn(category: GoalTemplateCategory): GoalTemplate[] {
  return GOAL_TEMPLATES.filter((template) => (category === 'featured' ? template.featured : template.category === category));
}
