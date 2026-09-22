import { type AppIcon } from '@/lib/icons';

/**
 * OAuth provider configuration
 */
export interface OAuthProviderConfig {
  id: 'google' | 'github' | 'apple';
  name: string;
  icon: AppIcon | React.ComponentType<any>;
  iconSource?: any; // For custom SVG/PNG icons
}

/**
 * Auth input field props
 */
export interface AuthInputProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  secureTextEntry?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoComplete?: string;
  keyboardType?: 'default' | 'email-address' | 'numeric' | 'phone-pad';
  returnKeyType?: 'done' | 'go' | 'next' | 'search' | 'send';
  onSubmitEditing?: () => void;
  error?: string;
}

/**
 * Auth form validation errors
 */
export interface AuthFormErrors {
  email?: string;
  password?: string;
  confirmPassword?: string;
  fullName?: string;
  general?: string;
}

