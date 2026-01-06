'use client';

import { useFormStatus } from 'react-dom';
import { useActionState } from 'react';
import { type ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from './alert';
import { AlertTriangle } from 'lucide-react';

type Props = Omit<ComponentProps<typeof Button>, 'formAction'> & {
  pendingText?: string;
  formAction: (prevState: any, formData: FormData) => Promise<any>;
  errorMessage?: string;
};

const initialState = {
  message: '',
};

export function SubmitButton({
  children,
  formAction,
  errorMessage,
  pendingText = 'Submitting...',
  ...props
}: Props) {
  const { pending, action } = useFormStatus();
  const [state, internalFormAction] = useActionState(formAction, initialState);

  const isPending = pending && action === internalFormAction;

  return (
    <div className="flex flex-col gap-y-4 w-full">
      {Boolean(errorMessage || state?.message) && (
        <Alert variant="destructive" className="w-full">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{errorMessage || state?.message}</AlertDescription>
        </Alert>
      )}
      <div>
        <Button
          {...props}
          type="submit"
          aria-disabled={pending}
          formAction={internalFormAction}
        >
          {isPending ? pendingText : children}
        </Button>
      </div>
    </div>
  );
}
