// Shared types for onboarding
export interface UserContext {
  name?: string;
  email?: string;
  userType?: 'individual' | 'company';
  industry?: string;
  companySize?: string;
  primaryGoals?: string[];
  websiteUrl?: string;
  role?: string; // User's role at their company
  extractedContext?: {
    businessType?: string;
    services?: string[];
    size?: string;
  };
  invitedTeammates?: string[];
  selectedAgents?: string[];
}

export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  component: React.ComponentType;
  canSkip?: boolean;
  actionLabel?: string;
}

export interface AIAgent {
  id: string;
  name: string;
  role: string;
  icon: string;
  description: string;
  category: string;
  tags: string[];
  capabilities: string[];
}

export interface ConfigurationField {
  key: string;
  label: string;
  type: 'select' | 'multiselect' | 'integrations' | 'text' | 'textarea';
  options?: string[] | any[];
  default?: any;
  placeholder?: string;
  description?: string;
}

export interface Integration {
  name: string;
  icon: string;
  description: string;
  category?: string;
}

