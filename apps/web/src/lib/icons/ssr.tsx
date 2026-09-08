/**
 * Icons for server components (RSC).
 *
 * React Server Components cannot read context, so IconProvider — which carries
 * the app-wide weight for the client tree — never reaches them. Phosphor's
 * context-free SSR entry defaults to "regular" instead, which would silently
 * ignore DEFAULT_ICON_WEIGHT.
 *
 * This module closes that gap: every icon below is the SSR icon with
 * DEFAULT_ICON_WEIGHT (src/lib/icons/icon-config.ts) already bound. Server
 * components import from here and, exactly like client components, never pass
 * a weight prop — one constant still governs the whole app. An explicit weight
 * (weight="fill" on solid/status icons) still wins.
 *
 * Adding an icon to a server component? Add its two lines here. Importing
 * '@phosphor-icons/react' directly in a server component crashes the build
 * (its main entry calls createContext at module scope).
 */
import type { Icon, IconProps } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { DEFAULT_ICON_WEIGHT } from './icon-config';

import {
  ActivityIcon as ActivityBase,
  AlarmIcon as AlarmBase,
  AppleLogoIcon as AppleLogoBase,
  ArrowLeftIcon as ArrowLeftBase,
  ArrowRightIcon as ArrowRightBase,
  ArrowClockwiseIcon as ArrowsClockwiseBase,
  AtIcon as AtBase,
  AtomIcon as AtomBase,
  BookOpenIcon as BookOpenBase,
  BrainIcon as BrainBase,
  BroadcastIcon as BroadcastBase,
  BrowserIcon as BrowserBase,
  BugIcon as BugBase,
  CalculatorIcon as CalculatorBase,
  CalendarDotsIcon as CalendarDotsBase,
  CalendarPlusIcon as CalendarPlusBase,
  CaretLeftIcon as CaretLeftBase,
  CaretRightIcon as CaretRightBase,
  ChartBarIcon as ChartBarBase,
  ChartLineIcon as ChartLineBase,
  ChatsIcon as ChatsBase,
  CheckIcon as CheckBase,
  CheckCircleIcon as CheckCircleBase,
  ClipboardTextIcon as ClipboardTextBase,
  CloudIcon as CloudBase,
  CodeIcon as CodeBase,
  CoffeeIcon as CoffeeBase,
  CpuIcon as CpuBase,
  CreditCardIcon as CreditCardBase,
  CubeIcon as CubeBase,
  CurrencyCircleDollarIcon as CurrencyCircleDollarBase,
  DatabaseIcon as DatabaseBase,
  DesktopIcon as DesktopBase,
  DeviceMobileIcon as DeviceMobileBase,
  EnvelopeIcon as EnvelopeBase,
  FileLockIcon as FileLockBase,
  FileSearchIcon as FileSearchBase,
  FileTextIcon as FileTextBase,
  FilesIcon as FilesBase,
  FlagIcon as FlagBase,
  FlaskIcon as FlaskBase,
  FunnelIcon as FunnelBase,
  GaugeIcon as GaugeBase,
  GitBranchIcon as GitBranchBase,
  GitMergeIcon as GitMergeBase,
  GitPullRequestIcon as GitPullRequestBase,
  GithubLogoIcon as GithubLogoBase,
  GooglePlayLogoIcon as GooglePlayLogoBase,
  HandshakeIcon as HandshakeBase,
  KeyIcon as KeyBase,
  LinuxLogoIcon as LinuxLogoBase,
  ListChecksIcon as ListChecksBase,
  MinusIcon as MinusBase,
  PackageIcon as PackageBase,
  PaperPlaneTiltIcon as PaperPlaneTiltBase,
  PathIcon as PathBase,
  PhoneCallIcon as PhoneCallBase,
  PlugsConnectedIcon as PlugsConnectedBase,
  PresentationIcon as PresentationBase,
  QuestionIcon as QuestionBase,
  ReceiptIcon as ReceiptBase,
  RepeatIcon as RepeatBase,
  RobotIcon as RobotBase,
  RocketIcon as RocketBase,
  ScalesIcon as ScalesBase,
  ScrollIcon as ScrollBase,
  ShareNetworkIcon as ShareNetworkBase,
  ShieldCheckIcon as ShieldCheckBase,
  ShieldWarningIcon as ShieldWarningBase,
  SignatureIcon as SignatureBase,
  SirenIcon as SirenBase,
  SparkleIcon as SparkleBase,
  TagIcon as TagBase,
  TargetIcon as TargetBase,
  TerminalWindowIcon as TerminalBase,
  TicketIcon as TicketBase,
  TrendDownIcon as TrendDownBase,
  TrendUpIcon as TrendUpBase,
  UserFocusIcon as UserFocusBase,
  UserMinusIcon as UserMinusBase,
  UserPlusIcon as UserPlusBase,
  UsersIcon as UsersBase,
  WalletIcon as WalletBase,
  WarningIcon as WarningBase,
  WindowsLogoIcon as WindowsLogoBase,
  WrenchIcon as WrenchBase,
} from '@phosphor-icons/react/dist/ssr';

type SsrIcon = (props: IconProps) => ReactNode;

function withDefaultWeight(Base: Icon): SsrIcon {
  return function BoundIcon(props: IconProps) {
    return <Base {...props} weight={props.weight ?? DEFAULT_ICON_WEIGHT} />;
  };
}

export const ActivityIcon = withDefaultWeight(ActivityBase);
export const AlarmIcon = withDefaultWeight(AlarmBase);
export const AppleLogoIcon = withDefaultWeight(AppleLogoBase);
export const ArrowLeftIcon = withDefaultWeight(ArrowLeftBase);
export const ArrowRightIcon = withDefaultWeight(ArrowRightBase);
export const ArrowClockwiseIcon = withDefaultWeight(ArrowsClockwiseBase);
export const AtIcon = withDefaultWeight(AtBase);
export const AtomIcon = withDefaultWeight(AtomBase);
export const BookOpenIcon = withDefaultWeight(BookOpenBase);
export const BrainIcon = withDefaultWeight(BrainBase);
export const BrowserIcon = withDefaultWeight(BrowserBase);
export const CodeIcon = withDefaultWeight(CodeBase);
export const CpuIcon = withDefaultWeight(CpuBase);
export const CubeIcon = withDefaultWeight(CubeBase);
export const DesktopIcon = withDefaultWeight(DesktopBase);
export const GitBranchIcon = withDefaultWeight(GitBranchBase);
export const PlugsConnectedIcon = withDefaultWeight(PlugsConnectedBase);
export const RobotIcon = withDefaultWeight(RobotBase);
export const BroadcastIcon = withDefaultWeight(BroadcastBase);
export const BugIcon = withDefaultWeight(BugBase);
export const CalculatorIcon = withDefaultWeight(CalculatorBase);
export const CalendarDotsIcon = withDefaultWeight(CalendarDotsBase);
export const CalendarPlusIcon = withDefaultWeight(CalendarPlusBase);
export const CaretLeftIcon = withDefaultWeight(CaretLeftBase);
export const CaretRightIcon = withDefaultWeight(CaretRightBase);
export const ChartBarIcon = withDefaultWeight(ChartBarBase);
export const ChartLineIcon = withDefaultWeight(ChartLineBase);
export const ChatsIcon = withDefaultWeight(ChatsBase);
export const CheckCircleIcon = withDefaultWeight(CheckCircleBase);
export const CheckIcon = withDefaultWeight(CheckBase);
export const ClipboardTextIcon = withDefaultWeight(ClipboardTextBase);
export const CloudIcon = withDefaultWeight(CloudBase);
export const CoffeeIcon = withDefaultWeight(CoffeeBase);
export const CreditCardIcon = withDefaultWeight(CreditCardBase);
export const CurrencyCircleDollarIcon = withDefaultWeight(CurrencyCircleDollarBase);
export const DatabaseIcon = withDefaultWeight(DatabaseBase);
export const DeviceMobileIcon = withDefaultWeight(DeviceMobileBase);
export const EnvelopeIcon = withDefaultWeight(EnvelopeBase);
export const FileLockIcon = withDefaultWeight(FileLockBase);
export const FileSearchIcon = withDefaultWeight(FileSearchBase);
export const FileTextIcon = withDefaultWeight(FileTextBase);
export const FilesIcon = withDefaultWeight(FilesBase);
export const FlagIcon = withDefaultWeight(FlagBase);
export const FlaskIcon = withDefaultWeight(FlaskBase);
export const FunnelIcon = withDefaultWeight(FunnelBase);
export const GaugeIcon = withDefaultWeight(GaugeBase);
export const GitMergeIcon = withDefaultWeight(GitMergeBase);
export const GitPullRequestIcon = withDefaultWeight(GitPullRequestBase);
export const GithubLogoIcon = withDefaultWeight(GithubLogoBase);
export const GooglePlayLogoIcon = withDefaultWeight(GooglePlayLogoBase);
export const HandshakeIcon = withDefaultWeight(HandshakeBase);
export const KeyIcon = withDefaultWeight(KeyBase);
export const LinuxLogoIcon = withDefaultWeight(LinuxLogoBase);
export const ListChecksIcon = withDefaultWeight(ListChecksBase);
export const MinusIcon = withDefaultWeight(MinusBase);
export const PackageIcon = withDefaultWeight(PackageBase);
export const PaperPlaneTiltIcon = withDefaultWeight(PaperPlaneTiltBase);
export const PathIcon = withDefaultWeight(PathBase);
export const PhoneCallIcon = withDefaultWeight(PhoneCallBase);
export const PresentationIcon = withDefaultWeight(PresentationBase);
export const QuestionIcon = withDefaultWeight(QuestionBase);
export const ReceiptIcon = withDefaultWeight(ReceiptBase);
export const RepeatIcon = withDefaultWeight(RepeatBase);
export const RocketIcon = withDefaultWeight(RocketBase);
export const ScalesIcon = withDefaultWeight(ScalesBase);
export const ScrollIcon = withDefaultWeight(ScrollBase);
export const ShareNetworkIcon = withDefaultWeight(ShareNetworkBase);
export const ShieldCheckIcon = withDefaultWeight(ShieldCheckBase);
export const ShieldWarningIcon = withDefaultWeight(ShieldWarningBase);
export const SignatureIcon = withDefaultWeight(SignatureBase);
export const SirenIcon = withDefaultWeight(SirenBase);
export const SparkleIcon = withDefaultWeight(SparkleBase);
export const TagIcon = withDefaultWeight(TagBase);
export const TargetIcon = withDefaultWeight(TargetBase);
export const TerminalIcon = withDefaultWeight(TerminalBase);
export const TicketIcon = withDefaultWeight(TicketBase);
export const TrendDownIcon = withDefaultWeight(TrendDownBase);
export const TrendUpIcon = withDefaultWeight(TrendUpBase);
export const UserFocusIcon = withDefaultWeight(UserFocusBase);
export const UserMinusIcon = withDefaultWeight(UserMinusBase);
export const UserPlusIcon = withDefaultWeight(UserPlusBase);
export const UsersIcon = withDefaultWeight(UsersBase);
export const WalletIcon = withDefaultWeight(WalletBase);
export const WindowsLogoIcon = withDefaultWeight(WindowsLogoBase);
export const WarningIcon = withDefaultWeight(WarningBase);
export const WrenchIcon = withDefaultWeight(WrenchBase);
