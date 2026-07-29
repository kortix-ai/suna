import { cn } from '@/lib/utils';

export default function Loading({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cn('size-4 text-current animate-spinner-orbit', className)}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <circle
        className="animate-spinner-dash"
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}
