import { Reveal } from '@/components/home/reveal';

type Props = {
  eyebrow: string;
  title: string;
  description?: string;
};

const SectionHeader = ({ eyebrow, title, description }: Props) => {
  return (
    <Reveal>
      <div className="flex w-full flex-col gap-4 select-none">
        <span
          className="text-muted-foreground font-mono text-[0.75rem] leading-none font-normal uppercase select-none"
          data-text="true"
        >
          {eyebrow}
        </span>
        <h2
          data-heading="true"
          className="text-foreground max-w-2xl font-sans text-2xl font-medium text-balance sm:text-3xl"
        >
          {title}
        </h2>
      </div>

      <p className="text-muted-foreground mt-4 max-w-2xl text-base leading-relaxed">
        {description}
      </p>
    </Reveal>
  );
};

export default SectionHeader;
