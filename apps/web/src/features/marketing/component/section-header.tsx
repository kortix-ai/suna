import { Reveal } from '@/components/home/reveal';
import { cn } from '@/lib/utils';

type Props = {
  eyebrow: string;
  title: string;
  description?: string;
  /** Overrides the title's type; the default is the landing-page size. */
  titleClassName?: string;
};

const SectionHeader = ({ eyebrow, title, description, titleClassName }: Props) => {
  return (
    <Reveal>
      <div className="flex w-full flex-col gap-4 select-none">
        {eyebrow && (
          <span
            className="text-muted-foreground font-mono text-[0.75rem] leading-none font-normal uppercase select-none"
            data-text="true"
          >
            {eyebrow}
          </span>
        )}
        <h2
          data-heading="true"
          className={cn(
            'text-foreground max-w-3xl font-sans text-3xl font-normal tracking-tight text-balance sm:text-5xl',
            titleClassName,
          )}
        >
          {title}
        </h2>
      </div>

      <p className="text-muted-foreground mt-5 max-w-2xl text-lg leading-relaxed text-pretty">
        {description}
      </p>
    </Reveal>
  );
};

export default SectionHeader;
