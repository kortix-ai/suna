// Original onboarding components
export { OnboardingPage } from './onboarding-page';
export { OnboardingProvider } from './onboarding-provider';
export { defaultOnboardingSteps, WelcomeStep, FeaturesOverviewStep, QuickStartStep, CompletionStep } from './onboarding-steps';
export { UserTypeStep } from './user-type-step';
export { useOnboarding, usePostSubscriptionOnboarding } from '@/hooks/use-onboarding';
export type { OnboardingStep } from '@/hooks/use-onboarding';

// Legacy/alternative exports for backward compatibility
export { defaultOnboardingSteps as onboardingSteps } from './onboarding-steps';

// New onboarding components (if needed)
export { NewOnboardingPage } from './new-onboarding-page';

// Step components
export { CEOIntroStep } from './steps/ceo-intro-step';
export { SmartContextStep } from './steps/smart-context-step';
export { WorkforceSelectionStep } from './steps/workforce-selection-step';
export { TeamInvitationStep } from './steps/team-invitation-step';
export { CompletionStep as NewCompletionStep } from './steps/completion-step';

// Agent configuration
export { MultiAgentConfigurationStep } from './agent-config/multi-agent-configuration';
export { AgentConfiguration } from './agent-config/agent-configuration';

// Shared components
export { StepWrapper } from './shared/step-wrapper';
export { AgentCard } from './shared/agent-card';
export { ProgressIndicator } from './shared/progress-indicator';

// Types and data
export type { UserContext, AIAgent, ConfigurationField, Integration } from './shared/types';
export { allAgents, agentCategories, integrationsByAgent } from './shared/data';
export { userContext, updateUserContext, resetUserContext } from './shared/context';