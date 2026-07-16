import { cn } from '@/lib/utils';

const Loading = ({ className }: { className?: string }) => {
  return (
    <svg
      className={cn(
        'animate-spinner-orbit text-foreground in-[button]:text-background in-data-[slot=button]:text-background size-4',
        className,
      )}
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
};

export default Loading;
