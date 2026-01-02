'use client';

import { useAuth } from '@/components/AuthProvider';
import { cn } from '@/lib/utils';

interface GreetingSuggestionsProps {
  onSuggestionClick: (suggestion: string) => void;
  className?: string;
}

const SUGGESTIONS = [
  'Suggest a daily routine to wake up earlier',
  'Quiz me on capitals of U.S. states',
  'Give me 10 dinner ideas with eggs and rice',
];

export function GreetingSuggestions({ onSuggestionClick, className }: GreetingSuggestionsProps) {
  const { user } = useAuth();
  
  // Extract first name from user metadata or email
  const getUserFirstName = () => {
    if (!user) return null;
    
    const name = user.user_metadata?.name;
    if (name) {
      // Extract first name if full name is provided
      const firstName = name.split(' ')[0];
      return firstName;
    }
    
    // Fallback to email username
    if (user.email) {
      return user.email.split('@')[0];
    }
    
    return null;
  };

  const firstName = getUserFirstName();

  return (
    <div className={cn('flex flex-col gap-6 items-start w-full', className)}>
      {/* Header Section */}
      <div className="flex flex-col gap-2 items-center justify-center w-full px-4">
        <div className="flex flex-col justify-center w-full">
          <p className="text-[36px] leading-[40px] font-medium text-foreground text-center">
            {firstName ? `Hi ${firstName},` : 'Hi there,'}
          </p>
        </div>
        <div className="flex flex-col justify-center w-full opacity-50">
          <p className="text-[36px] leading-[40px] font-medium text-foreground/60 text-center">
            Try These:
          </p>
        </div>
      </div>

      {/* Suggestions Section */}
      <div className="flex flex-col gap-2 items-start justify-center w-full">
        {SUGGESTIONS.map((suggestion, index) => (
          <button
            key={index}
            onClick={() => onSuggestionClick(suggestion)}
            className="w-full bg-muted dark:bg-muted/80 border border-border dark:border-border/80 rounded-full h-12 px-4 flex items-center justify-center hover:bg-accent/50 dark:hover:bg-accent/30 transition-colors cursor-pointer group active:scale-[0.98]"
          >
            <div className="flex items-center justify-center px-2">
              <p className="text-base font-medium text-foreground dark:text-foreground whitespace-nowrap group-hover:text-foreground transition-colors">
                {suggestion}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

