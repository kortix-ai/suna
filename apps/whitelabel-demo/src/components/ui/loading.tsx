import { cn } from '@/lib/utils';

const Loading = ({ className }: { className?: string }) => {
  return (
    <svg
      className={cn(
        'text-foreground in-[button]:text-background in-data-[slot=button]:text-background size-4',
        className,
      )}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ animation: 'spinner-rotate 2s linear infinite' }}
    >
      <style>{`
        @keyframes spinner-rotate {
          to { transform: rotate(360deg); }
        }
        @keyframes spinner-dash {
          0%   { stroke-dasharray: 1, 70;  stroke-dashoffset: 0; }
          50%  { stroke-dasharray: 45, 70; stroke-dashoffset: -18; }
          100% { stroke-dasharray: 45, 70; stroke-dashoffset: -62; }
        }
      `}</style>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        style={{ animation: 'spinner-dash 1.5s ease-in-out infinite' }}
      />
    </svg>
  );
};

export default Loading;
