import { SectionHeader } from '@/components/home/section-header';
import { Feature as FeatureComponent } from '@/components/home/ui/feature-slideshow';
import { siteConfig } from '@/lib/home';

export function FeatureSection() {
  const { title, description, items } = siteConfig.featureSection;

  return (
    <section
      id="features"
      className="flex flex-col items-center justify-center gap-5 w-full relative px-6"
    >
      <SectionHeader>
        <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance">
          {title}
        </h2>
        <p className="text-muted-foreground text-center text-balance font-medium">
          {description}
        </p>
      </SectionHeader>
      <div className="w-full h-full lg:h-[450px] flex items-center justify-center">
        <FeatureComponent
          collapseDelay={5000}
          linePosition="bottom"
          featureItems={items}
          lineColor="bg-secondary"
        />
      </div>
    </section>
  );
}
