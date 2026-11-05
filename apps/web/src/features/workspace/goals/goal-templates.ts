import {
  AddressBookIcon,
  ArticleIcon,
  BankIcon,
  BinocularsIcon,
  BookOpenTextIcon,
  BriefcaseIcon,
  BugIcon,
  CalculatorIcon,
  CalendarCheckIcon,
  ChartBarIcon,
  ChartLineUpIcon,
  ChatsCircleIcon,
  CheckCircleIcon,
  ClipboardTextIcon,
  CodeIcon,
  CreditCardIcon,
  DatabaseIcon,
  EnvelopeSimpleIcon,
  FileTextIcon,
  FolderOpenIcon,
  GaugeIcon,
  GearSixIcon,
  GitPullRequestIcon,
  GlobeIcon,
  HandshakeIcon,
  HeartIcon,
  IdentificationCardIcon,
  InvoiceIcon,
  LifebuoyIcon,
  LightbulbIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  MegaphoneIcon,
  PackageIcon,
  PencilLineIcon,
  PresentationChartIcon,
  QuestionIcon,
  ReceiptIcon,
  ScalesIcon,
  ShieldCheckIcon,
  StackIcon,
  TableIcon,
  TargetIcon,
  TrayIcon,
  TruckIcon,
  UserCheckIcon,
  UserListIcon,
  UserPlusIcon,
  WalletIcon,
  type Icon,
} from '@phosphor-icons/react';

/** The tabs of the template gallery, in order: the business roles a goal is handed over by. */
export const GOAL_TEMPLATE_ROLES = ['founder', 'sales', 'marketing', 'support', 'finance', 'operations', 'people', 'engineering'] as const;
export type GoalTemplateRole = (typeof GOAL_TEMPLATE_ROLES)[number];

/** The accent of a template's glyph. Only the glyph takes it: the words stay ink (brand color rule). */
export type GoalTemplateAccent = 'blue' | 'green' | 'orange' | 'purple' | 'red' | 'yellow';

/**
 * One starting point for a goal, for one business role. The card says what
 * the agent does first and what it leaves behind (`steps`). Picking it puts
 * the template's prompt in the composer for the person to finish; nothing
 * starts until they send. The copy lives in `goals.templates.<id>` (`title`,
 * `description`, `prompt`, `criterion`, `start`, `done`).
 */
export interface GoalTemplate {
  id: string;
  role: GoalTemplateRole;
  icon: Icon;
  accent: GoalTemplateAccent;
  /** The first step's glyph, then the glyph of what the goal leaves behind. */
  steps: [Icon, Icon];
}

// prettier-ignore
export const GOAL_TEMPLATES: readonly GoalTemplate[] = [
  { id: 'draftInvestorUpdate', role: 'founder', icon: PresentationChartIcon, accent: 'blue', steps: [ChartLineUpIcon, FileTextIcon] },
  { id: 'compareCompetitors', role: 'founder', icon: BinocularsIcon, accent: 'purple', steps: [GlobeIcon, TableIcon] },
  { id: 'summarizeCustomerFeedback', role: 'founder', icon: ChatsCircleIcon, accent: 'green', steps: [MagnifyingGlassIcon, ChartBarIcon] },
  { id: 'prepareDecisionBrief', role: 'founder', icon: ScalesIcon, accent: 'orange', steps: [FolderOpenIcon, LightbulbIcon] },
  { id: 'researchTargetAccounts', role: 'sales', icon: TargetIcon, accent: 'blue', steps: [GlobeIcon, TableIcon] },
  { id: 'draftDealFollowups', role: 'sales', icon: EnvelopeSimpleIcon, accent: 'green', steps: [AddressBookIcon, PencilLineIcon] },
  { id: 'enrichSelectedLeads', role: 'sales', icon: UserListIcon, accent: 'orange', steps: [MagnifyingGlassIcon, CheckCircleIcon] },
  { id: 'draftSalesProposal', role: 'sales', icon: HandshakeIcon, accent: 'purple', steps: [ChatsCircleIcon, FileTextIcon] },
  { id: 'draftLaunchCampaign', role: 'marketing', icon: MegaphoneIcon, accent: 'orange', steps: [FolderOpenIcon, PencilLineIcon] },
  { id: 'findContentGaps', role: 'marketing', icon: MagnifyingGlassIcon, accent: 'blue', steps: [GlobeIcon, TableIcon] },
  { id: 'rewriteLandingPage', role: 'marketing', icon: ArticleIcon, accent: 'purple', steps: [BinocularsIcon, FileTextIcon] },
  { id: 'analyzeCampaignResults', role: 'marketing', icon: ChartLineUpIcon, accent: 'green', steps: [ChartBarIcon, PresentationChartIcon] },
  { id: 'draftSupportReplies', role: 'support', icon: LifebuoyIcon, accent: 'blue', steps: [TrayIcon, PencilLineIcon] },
  { id: 'triageSupportBacklog', role: 'support', icon: ListChecksIcon, accent: 'orange', steps: [MagnifyingGlassIcon, TableIcon] },
  { id: 'draftHelpArticle', role: 'support', icon: BookOpenTextIcon, accent: 'green', steps: [ChatsCircleIcon, ArticleIcon] },
  { id: 'flagAtRiskAccounts', role: 'support', icon: HeartIcon, accent: 'purple', steps: [ChartLineUpIcon, FileTextIcon] },
  { id: 'reconcileExpenses', role: 'finance', icon: ReceiptIcon, accent: 'blue', steps: [BankIcon, TableIcon] },
  { id: 'prepareInvoiceFollowups', role: 'finance', icon: InvoiceIcon, accent: 'orange', steps: [CalculatorIcon, EnvelopeSimpleIcon] },
  { id: 'auditSubscriptionSpend', role: 'finance', icon: CreditCardIcon, accent: 'purple', steps: [MagnifyingGlassIcon, FileTextIcon] },
  { id: 'prepareCashForecast', role: 'finance', icon: WalletIcon, accent: 'green', steps: [ChartBarIcon, ChartLineUpIcon] },
  { id: 'compareVendorQuotes', role: 'operations', icon: TruckIcon, accent: 'blue', steps: [MagnifyingGlassIcon, TableIcon] },
  { id: 'documentBusinessProcess', role: 'operations', icon: GearSixIcon, accent: 'green', steps: [FolderOpenIcon, BookOpenTextIcon] },
  { id: 'reconcileInventoryRecords', role: 'operations', icon: PackageIcon, accent: 'orange', steps: [DatabaseIcon, ListChecksIcon] },
  { id: 'prepareProjectHandoff', role: 'operations', icon: BriefcaseIcon, accent: 'purple', steps: [ClipboardTextIcon, FileTextIcon] },
  { id: 'draftJobDescription', role: 'people', icon: UserPlusIcon, accent: 'blue', steps: [ClipboardTextIcon, FileTextIcon] },
  { id: 'buildOnboardingPlan', role: 'people', icon: UserCheckIcon, accent: 'green', steps: [FolderOpenIcon, CalendarCheckIcon] },
  { id: 'prepareInterviewKit', role: 'people', icon: IdentificationCardIcon, accent: 'purple', steps: [MagnifyingGlassIcon, QuestionIcon] },
  { id: 'organizePeopleHandbook', role: 'people', icon: BookOpenTextIcon, accent: 'orange', steps: [ListChecksIcon, ArticleIcon] },
  { id: 'fixReportedBug', role: 'engineering', icon: BugIcon, accent: 'red', steps: [MagnifyingGlassIcon, GitPullRequestIcon] },
  { id: 'buildScopedFeature', role: 'engineering', icon: CodeIcon, accent: 'blue', steps: [ClipboardTextIcon, CheckCircleIcon] },
  { id: 'improveSlowFlow', role: 'engineering', icon: GaugeIcon, accent: 'orange', steps: [ChartBarIcon, ChartLineUpIcon] },
  { id: 'patchVulnerableDependencies', role: 'engineering', icon: ShieldCheckIcon, accent: 'green', steps: [StackIcon, FileTextIcon] },
];

export function goalTemplatesFor(role: GoalTemplateRole): GoalTemplate[] {
  return GOAL_TEMPLATES.filter((template) => template.role === role);
}
