import { Reveal } from '@/components/home/reveal';
import { cn } from '@/lib/utils';

type Props = {
  eyebrow: string;
  title: string;
  description?: string;
  /** Overrides the title's type; the default is the landing-page size. */
  titleClassName?: string;
  /** `h1` when this header opens the page. */
  as?: 'h1' | 'h2';
};

const SectionHeader = ({ eyebrow, title, description, titleClassName, as: Heading = 'h2' }: Props) => {
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
        <Heading
          data-heading="true"
          className={cn(
            'text-foreground max-w-2xl font-sans text-2xl font-medium text-balance sm:text-3xl',
            titleClassName,
          )}
        >
          {title}
        </Heading>
      </div>

      <p className="text-muted-foreground mt-4 max-w-2xl text-base leading-relaxed">
        {description}
      </p>
    </Reveal>
  );
};

export default SectionHeader;
