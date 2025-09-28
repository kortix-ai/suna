'use client';

import { useState } from 'react';
import { useActionState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { createTeam } from '@/lib/actions/teams';
import { SubmitButton } from '@/components/ui/submit-button';
import { AtSign, Check, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

const initialState = {
  message: '',
};

export default function NewTeamForm() {
  const [state, formAction] = useActionState(createTeam, initialState);
  const [slugValue, setSlugValue] = useState('');
  const [nameValue, setNameValue] = useState('');

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setNameValue(value);

    // Auto-generate slug from name if user hasn't manually entered a slug yet
    if (!slugValue) {
      const generatedSlug = value
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '');
      setSlugValue(generatedSlug);
    }
  };

  return (
    <form className="space-y-6 mt-2">
      <div className="space-y-4">
        <div className="space-y-2.5">
          <Label
            htmlFor="name"
            className="text-sm font-medium text-foreground/90 flex items-center gap-2"
          >
            Team Name
          </Label>
          <div className="relative">
            <Input
              id="name"
              name="name"
              value={nameValue}
              onChange={handleNameChange}
              placeholder="Acme Corporation"
              className="h-10 pr-9 rounded-lg border-input/60 dark:border-white/10 bg-white dark:bg-background-secondary shadow-xs focus-visible:ring-primary/30"
              required
            />
            {nameValue && (
              <Check className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-green-500" />
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            This is the name that will appear in the team switcher.
          </p>
        </div>

        <div className="space-y-2.5">
          <Label
            htmlFor="slug"
            className="text-sm font-medium text-foreground/90 flex items-center gap-2"
          >
            Team URL{' '}
            <span className="text-xs text-muted-foreground">
              (unique identifier)
            </span>
          </Label>
          <div className="flex items-center gap-x-1.5 relative rounded-lg border-input/60 dark:border-white/10 bg-white dark:bg-background-secondary shadow-xs pl-3 border overflow-hidden focus-within:ring-3 focus-within:ring-primary/30 focus-within:border-ring group">
            <AtSign className="size-4 text-muted-foreground group-focus-within:text-foreground/80" />
            <Input
              id="slug"
              name="slug"
              value={slugValue}
              onChange={(e) => setSlugValue(e.target.value)}
              placeholder="acme"
              className="h-10 border-0 bg-transparent shadow-none focus-visible:ring-0 pl-0 w-full"
              required
            />
          </div>
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="size-3.5 mt-0.5 text-muted-foreground/70" />
            <p>
              This will be used for your team URL:
              <span className="block text-primary font-medium mt-0.5">
                yourapp.com/{slugValue || 'team-name'}
              </span>
            </p>
          </div>
        </div>
      </div>

      {state?.message && (
        <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950/20 p-3 rounded-lg border border-red-100 dark:border-red-900/20 flex items-center gap-2">
          <Info className="size-4 text-red-500" />
          <p>{state.message}</p>
        </div>
      )}

      <SubmitButton
        formAction={async (prevState: any, formData: FormData) =>
          formAction(formData)
        }
        pendingText="Creating team..."
        className={cn(
          'w-full rounded-lg shadow-xs transition-all',
          'bg-primary hover:bg-primary/90 text-white',
          'dark:bg-primary/90 dark:hover:bg-primary',
        )}
        size="lg"
      >
        Create Team
      </SubmitButton>
    </form>
  );
}
