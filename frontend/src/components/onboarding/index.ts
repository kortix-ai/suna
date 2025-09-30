// Active onboarding components
export { OnboardingProvider } from './onboarding-provider';
export { useOnboarding, usePostSubscriptionOnboarding } from '@/hooks/use-onboarding';
export type { OnboardingStep } from '@/hooks/use-onboarding';

// Main onboarding page
export { NewOnboardingPage } from './new-onboarding-page';

// Step components
export { CEOIntroStep } from './steps/ceo-intro-step';
export { UserTypeStep } from './steps/user-type-step';
export { SmartContextStep } from './steps/smart-context-step';
export { WorkforceSelectionStep } from './steps/workforce-selection-step';
export { TeamInvitationStep } from './steps/team-invitation-step';
export { CompletionStep as NewCompletionStep } from './steps/completion-step';

// Agent configuration
export { MultiAgentConfigurationStep } from './agent-config/multi-agent-configuration';
export { AgentConfiguration } from './agent-config/agent-configuration';

// Shared components
export { StepWrapper } from './shared/step-wrapper';
export { ProgressIndicator } from './shared/progress-indicator';

// Types and data
export type { UserContext, AIAgent, ConfigurationField, Integration } from './shared/types';
export { allAgents, agentCategories, integrationsByAgent } from './shared/data';
export { userContext, updateUserContext, resetUserContext } from './shared/context';