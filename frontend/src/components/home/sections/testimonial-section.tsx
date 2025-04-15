import { SectionHeader } from "@/components/home/section-header";
import { SocialProofTestimonials } from "@/components/home/testimonial-scroll";
import { siteConfig } from "@/lib/home";

export function TestimonialSection() {
  const { testimonials } = siteConfig;

  return (
    <section
      id="testimonials"
      className="flex flex-col items-center justify-center w-full"
    >
      <SectionHeader>
        <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance">
          Empower Your Workflow with AI
        </h2>
        <p className="text-muted-foreground text-center text-balance font-medium">
          Ask your AI Agent for real-time collaboration, seamless integrations,
          and actionable insights to streamline your operations.
        </p>
      </SectionHeader>
      <SocialProofTestimonials testimonials={testimonials} />
    </section>
  );
}
