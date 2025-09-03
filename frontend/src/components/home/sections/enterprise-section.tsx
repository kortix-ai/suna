import React from 'react';
import { useId } from 'react';
import { SectionHeader } from '@/components/home/section-header';
import { siteConfig } from '@/lib/home';
import { GradientText } from '@/components/animate-ui/text/gradient';
import { OmniProcessModal } from '@/components/sidebar/omni-enterprise-modal';

export function EnterpriseSection() {
  const enterpriseFeatures = [
    {
      title: "Security & Compliance",
      features: ["AES-256 Encryption", "FIPS 140-2 Standards", "Data Sovereignty", "Multi-Region Compliance"],
      description: "Bank-grade encryption protects your data at rest and in transit, while ensuring compliance with GDPR, HIPAA, SOC 2, and other regulatory standards across global regions.",
    },
    {
      title: "Identity & Access Management",
      features: ["Role-Based Access Control", "Single Sign-On (SSO)", "Granular Permissions", "Identity Provider Integration"],
      description: "Comprehensive access control with seamless SSO integration and granular role management to ensure secure access across your organization.",
    },
    {
      title: "Flexible Deployment Options",
      features: ["Single Tenant Cloud", "Virtual Private Cloud", "Hybrid Deployments", "On-Premise Solutions"],
      description: "Deploy Omni in your environment of choice - dedicated cloud resources, your own VPC, hybrid setups, or fully on-premise with all major cloud providers supported.",
    },
    {
      title: "Custom AI Agents",
      features: ["Specialized Workflows", "Business Process Integration", "Domain-Specific Training", "Custom Capabilities"],
      description: "Deploy specialized AI agents tailored to your specific business processes and workflows with domain-specific training and custom capabilities.",
    },
    {
      title: "Custom Tools & Integrations",
      features: ["API Integrations", "Custom Tool Development", "Existing Tech Stack", "Workflow Automation"],
      description: "Build and deploy custom tools that integrate seamlessly with your existing tech stack, enabling powerful workflow automation and system connectivity.",
    },
    {
      title: "Enterprise Training Programs",
      features: ["Team Workshops", "Productivity Training", "AI Adoption Programs", "Best Practices"],
      description: "Comprehensive training programs and workshops designed to maximize your team's productivity and accelerate AI adoption across your organization.",
    },
    {
      title: "Enterprise Analytics",
      features: ["Usage Monitoring", "Performance Metrics", "ROI Tracking", "Custom Dashboards"],
      description: "Advanced analytics and reporting tools to monitor usage patterns, track performance metrics, and measure ROI across your organization with custom dashboards.",
    },
    {
      title: "Enterprise Credit Plans",
      features: ["Volume Discounts", "Custom Billing", "Usage Patterns", "Flexible Pricing"],
      description: "Flexible credit-based pricing plans designed for enterprise usage patterns with volume discounts, custom billing cycles, and adaptable pricing structures.",
    },
    {
      title: "24/7 Enterprise Support",
      features: ["Dedicated Support", "Guaranteed Response Times", "Senior Engineers", "Priority Access"],
      description: "Round-the-clock dedicated support with guaranteed response times, direct access to senior engineers, and priority technical assistance for your enterprise.",
    },
  ];

  return (
    <section
      id="enterprise"
      className="flex flex-col items-center justify-center w-full relative py-12"
    >
      <div className="w-full max-w-7xl mx-auto px-6">
        <SectionHeader>
          <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance pb-1">
            Managed Enterprise Deployments
          </h2>
          <p className="text-muted-foreground text-center text-balance font-medium">
            Omni offers fully managed Enterprise deployments with advanced security, custom enterprise tooling, and flexible enterprise credit plans.
          </p>
        </SectionHeader>

        <div className="py-8 lg:py-12">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-7xl mx-auto">
            {enterpriseFeatures.map((feature) => (
              <div
                key={feature.title}
                className="relative bg-gradient-to-b dark:from-neutral-900 from-neutral-100 dark:to-neutral-950 to-white p-4 rounded-3xl overflow-hidden"
              >
                <Grid size={20} />
                <div className="relative z-20">
                  <h3 className="text-lg font-bold text-neutral-800 dark:text-white mb-3">
                    {feature.title === "Custom AI Agents" ? (
                      <>Custom <GradientText text="AI" /> Agents</>
                    ) : feature.title.includes("AI") ? (
                      feature.title.replace("AI", " AI ").split(" ").map((word, index) => 
                        word === "AI" ? <GradientText key={index} text="AI" /> : word + " "
                      )
                    ) : (
                      feature.title
                    )}
                  </h3>
                  
                  <div className="mb-3">
                    <div className="grid grid-cols-2 gap-2">
                      {feature.features.map((item, index) => (
                        <div key={index} className="flex items-center">
                          <div className="w-1.5 h-1.5 rounded-full bg-primary mr-2 flex-shrink-0"></div>
                          <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                            {item}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                  
                  <p className="text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">
                    {feature.title === "Enterprise Training Programs" ? (
                      <>Comprehensive training programs and workshops designed to maximize your team's productivity and accelerate <GradientText text="AI" /> adoption across your organization.</>
                    ) : feature.title === "Custom AI Agents" ? (
                      <>Deploy specialized <GradientText text="AI" /> agents tailored to your specific business processes and workflows with domain-specific training and custom capabilities.</>
                    ) : (
                      feature.description
                    )}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Motivational CTA Section */}
        <div className="flex flex-col items-center mt-12 space-y-6">
          <div className="text-center max-w-2xl">
            <h3 className="text-2xl md:text-3xl font-semibold tracking-tight text-primary mb-4">
              Supercharge your competitive advantage without giving it away
            </h3>
            <p className="text-lg text-muted-foreground leading-relaxed">
              Deploy <GradientText text="AI" /> agents that work exclusively for you. Keep your data, processes, and insights secure while scaling your capabilities beyond what any competitor can achieve.
            </p>
          </div>
          
          {/* Enhanced Schedule Demo CTA */}
          <div className="relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-secondary to-primary rounded-2xl blur opacity-25 group-hover:opacity-75 transition duration-300"></div>
            <div className="relative group inline-flex h-14 items-center justify-center gap-3 text-base font-semibold tracking-wide rounded-xl text-primary-foreground dark:text-black px-12 shadow-[0_4px_14px_0_rgba(0,0,0,0.1)] bg-primary dark:bg-white hover:bg-primary/90 dark:hover:bg-white/90 transition-all duration-300 hover:shadow-[0_6px_20px_rgba(0,0,0,0.15)] hover:scale-105">
              <OmniProcessModal />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export const Grid = ({
  pattern,
  size,
}: {
  pattern?: number[][];
  size?: number;
}) => {
  const p = pattern ?? [
    [Math.floor(Math.random() * 4) + 7, Math.floor(Math.random() * 6) + 1],
    [Math.floor(Math.random() * 4) + 7, Math.floor(Math.random() * 6) + 1],
    [Math.floor(Math.random() * 4) + 7, Math.floor(Math.random() * 6) + 1],
    [Math.floor(Math.random() * 4) + 7, Math.floor(Math.random() * 6) + 1],
    [Math.floor(Math.random() * 4) + 7, Math.floor(Math.random() * 6) + 1],
  ];
  return (
    <div className="pointer-events-none absolute left-1/2 top-0  -ml-20 -mt-2 h-full w-full [mask-image:linear-gradient(white,transparent)]">
      <div className="absolute inset-0 bg-gradient-to-r  [mask-image:radial-gradient(farthest-side_at_top,white,transparent)] dark:from-zinc-900/30 from-zinc-100/30 to-zinc-300/30 dark:to-zinc-900/30 opacity-100">
        <GridPattern
          width={size ?? 20}
          height={size ?? 20}
          x="-12"
          y="4"
          squares={p}
          className="absolute inset-0 h-full w-full  mix-blend-overlay dark:fill-white/10 dark:stroke-white/10 stroke-black/10 fill-black/10"
        />
      </div>
    </div>
  );
};

export function GridPattern({ width, height, x, y, squares, ...props }: any) {
  const patternId = useId();

  return (
    <svg aria-hidden="true" {...props}>
      <defs>
        <pattern
          id={patternId}
          width={width}
          height={height}
          patternUnits="userSpaceOnUse"
          x={x}
          y={y}
        >
          <path d={`M.5 ${height}V.5H${width}`} fill="none" />
        </pattern>
      </defs>
      <rect
        width="100%"
        height="100%"
        strokeWidth={0}
        fill={`url(#${patternId})`}
      />
      {squares && (
        <svg x={x} y={y} className="overflow-visible">
          {squares.map(([x, y]: any) => (
            <rect
              strokeWidth="0"
              key={`${x}-${y}`}
              width={width + 1}
              height={height + 1}
              x={x * width}
              y={y * height}
            />
          ))}
        </svg>
      )}
    </svg>
  );
} 