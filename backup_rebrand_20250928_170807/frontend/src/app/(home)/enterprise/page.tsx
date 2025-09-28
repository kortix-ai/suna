'use client';

import { useState } from 'react';
import { SectionHeader } from '@/components/home/section-header';
import { FooterSection } from '@/components/home/sections/footer-section';
import { motion } from 'motion/react';
import { 
  ArrowRight, 
  Check, 
  Clock, 
  Shield, 
  Users, 
  Zap,
  Star,
  Calendar,
  Headphones,
  Settings,
  TrendingUp,
  Sparkles
} from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { KortixEnterpriseModal } from '@/components/sidebar/kortix-enterprise-modal';
import { KortixLogo } from '@/components/sidebar/kortix-logo';

// Hero Section Component
const CustomHeroSection = () => {
  return (
    <section className="w-full relative overflow-hidden">
      <div className="relative flex flex-col items-center w-full px-6">
        <div className="relative z-10 pt-32 mx-auto h-full w-full max-w-6xl flex flex-col items-center justify-center">
          <div className="flex flex-col items-center justify-center gap-6 pt-12 max-w-4xl mx-auto">
            {/* Kortix Logo */}
            <div className="mb-8">
              <KortixLogo size={48} />
            </div>
            
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-primary/10 to-secondary/10 border border-primary/20">
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium text-primary">Enterprise Implementation Services</span>
            </div>
            
            <h1 className="text-4xl md:text-5xl lg:text-6xl xl:text-7xl font-medium tracking-tighter text-balance text-center">
              <span className="text-primary">Enterprise AI Workers.</span>
              <br />
              <span className="text-secondary">Delivered in days.</span>
            </h1>
            
            <p className="text-lg md:text-xl text-center text-muted-foreground font-medium text-balance leading-relaxed tracking-tight max-w-3xl">
              Skip the learning curve. Our AI specialists design, develop and deploy enterprise-grade AI workers that integrate seamlessly with your operations.
            </p>
            
            <div className="flex flex-col items-center gap-6 pt-6">
              <KortixEnterpriseModal>
                <Button size="lg">
                  <Calendar className="w-4 h-4 mr-2" />
                  Schedule Strategy Call
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </KortixEnterpriseModal>
              <div className="flex flex-col sm:flex-row items-center gap-4 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-primary"></div>
                  <span>Free consultation</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-primary"></div>
                  <span>Custom solution design</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-primary"></div>
                  <span>Tailored pricing</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="mb-16 sm:mt-32 mx-auto"></div>
      </div>
    </section>
  );
};

// Value Proposition Section
const ValuePropSection = () => {
  return (
    <section className="flex flex-col items-center justify-center w-full relative">
      <div className="relative w-full px-6">
        <div className="max-w-6xl mx-auto border-l border-r border-border">
          <SectionHeader>
            <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance pb-1">
              When Standard Solutions Fall Short
            </h2>
            <p className="text-muted-foreground text-center text-balance font-medium">
              Professional implementation services designed for organizations with unique requirements and mission-critical automation needs.
            </p>
          </SectionHeader>

          <div className="grid grid-cols-1 md:grid-cols-2 border-t border-border">
            <div className="p-8 border-r border-border">
              <div className="space-y-6">
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <Clock className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h3 className="text-xl font-semibold mb-3">Accelerate Time-to-Value</h3>
                  <p className="text-muted-foreground leading-relaxed">
                    Bypass months of development cycles. Our proven methodology delivers enterprise-ready AI workers in a fraction of the time, letting you focus on strategy instead of implementation.
                  </p>
                </div>
              </div>
            </div>
            
            <div className="p-8">
              <div className="space-y-6">
                <div className="w-12 h-12 rounded-full bg-secondary/10 flex items-center justify-center">
                  <Settings className="w-6 h-6 text-secondary" />
                </div>
                <div>
                  <h3 className="text-xl font-semibold mb-3">Enterprise Integration</h3>
                  <p className="text-muted-foreground leading-relaxed">
                    Designed for sophisticated business processes requiring seamless integration with legacy systems, compliance frameworks, and industry-specific requirements.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

// Implementation Process Section
const ProcessSection = () => {
  const steps = [
    {
      icon: <Users className="w-8 h-8" />,
      title: "Strategic Analysis",
      description: "Solution architects conduct comprehensive business analysis, workflow mapping, and technical requirements gathering to design optimal AI worker architecture for your organization.",
      phase: "Discovery"
    },
    {
      icon: <Zap className="w-8 h-8" />,
      title: "Engineering Excellence", 
      description: "Full-stack development with enterprise security, scalability design, comprehensive testing, performance optimization, and seamless integration with existing systems.",
      phase: "Build"
    },
    {
      icon: <Shield className="w-8 h-8" />,
      title: "Enterprise Support",
      description: "Dedicated success management, comprehensive training programs, continuous performance monitoring, optimization services, and satisfaction guarantee with full accountability.",
      phase: "Scale"
    }
  ];

  return (
    <section className="flex flex-col items-center justify-center w-full relative">
      <div className="relative w-full px-6">
        <div className="max-w-6xl mx-auto border-l border-r border-border">
          <SectionHeader>
            <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance pb-1">
              Our Implementation Methodology
            </h2>
            <p className="text-muted-foreground text-center text-balance font-medium">
              A proven three-phase approach that transforms your vision into production-ready AI workers
            </p>
          </SectionHeader>

          <div className="border-t border-border">
            {steps.map((step, index) => (
              <motion.div
                key={index}
                className={`flex flex-col md:flex-row gap-8 p-8 ${index !== steps.length - 1 ? 'border-b border-border' : ''}`}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: index * 0.1 }}
                viewport={{ once: true }}
              >
                <div className="flex-shrink-0">
                  <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/20 to-secondary/20 flex items-center justify-center text-primary border border-primary/20">
                    {step.icon}
                  </div>
                </div>
                
                <div className="flex-1 space-y-3">
                  <div className="flex items-center gap-3">
                    <h3 className="text-xl font-semibold">{step.title}</h3>
                    <span className="px-3 py-1 text-xs font-medium bg-secondary/10 text-secondary rounded-full">
                      {step.phase}
                    </span>
                  </div>
                  <p className="text-muted-foreground leading-relaxed">
                    {step.description}
                  </p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

// Benefits Section
const BenefitsSection = () => {
  const benefits = [
    "Dedicated solution architect and technical lead for your project",
    "Enterprise-grade AI worker design with scalability considerations",
    "White-glove support with dedicated success manager", 
    "Comprehensive team training and knowledge transfer",
    "Quarterly business reviews and performance optimization",
    "Deep integration with existing technology stack and workflows"
  ];

  return (
    <section className="flex flex-col items-center justify-center w-full relative">
      <div className="relative w-full px-6">
        <div className="max-w-6xl mx-auto border-l border-r border-border">
          <SectionHeader>
            <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance pb-1">
              Enterprise-Grade Implementation
            </h2>
            <p className="text-muted-foreground text-center text-balance font-medium">
              Premium service tier with dedicated resources and tailored solutions for complex organizational needs
            </p>
          </SectionHeader>

          <div className="border-t border-border p-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {benefits.map((benefit, index) => (
                <motion.div
                  key={index}
                  className="flex items-start gap-3 p-4 rounded-lg hover:bg-accent/20 transition-colors"
                  initial={{ opacity: 0, x: -20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.5, delay: index * 0.1 }}
                  viewport={{ once: true }}
                >
                  <div className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center mt-0.5">
                    <Check className="w-3 h-3 text-primary" />
                  </div>
                  <p className="text-sm font-medium leading-relaxed">{benefit}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

// Testimonials Section
const TestimonialsSection = () => {
  const testimonials = [
    {
      quote: "The implementation team transformed our entire workflow. Their expertise in enterprise AI deployment is unmatched.",
      author: "Sarah Chen",
      company: "TechFlow Industries",
      avatar: "🚀"
    },
    {
      quote: "ROI was evident within the first month. The AI workers handle our most complex processes flawlessly.",
      author: "Marcus Rodriguez", 
      company: "Global Manufacturing Corp",
      avatar: "💡"
    },
    {
      quote: "Outstanding technical depth and business understanding. They delivered exactly what we envisioned.",
      author: "Dr. Amanda Foster",
      company: "Research Dynamics LLC",
      avatar: "⭐"
    },
    {
      quote: "Professional, reliable, and innovative. The custom solution exceeded our expectations completely.",
      author: "James Wellington",
      company: "Strategic Ventures Group", 
      avatar: "🎯"
    }
  ];

  return (
    <section className="flex flex-col items-center justify-center w-full relative">
      <div className="relative w-full px-6">
        <div className="max-w-6xl mx-auto border-l border-r border-border">
          <SectionHeader>
            <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance pb-1">
              Client Success Stories
            </h2>
            <p className="text-muted-foreground text-center text-balance font-medium">
              Organizations that have transformed their operations with our enterprise implementation services
            </p>
          </SectionHeader>

          <div className="border-t border-border">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-0">
              {testimonials.map((testimonial, index) => (
                <motion.div
                  key={index}
                  className={`p-8 ${index % 2 === 0 ? 'md:border-r border-border' : ''} ${index < 2 ? 'border-b border-border' : ''}`}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.6, delay: index * 0.1 }}
                  viewport={{ once: true }}
                >
                  <div className="space-y-4">
                    <div className="flex items-center gap-1">
                      {[...Array(5)].map((_, i) => (
                        <Star key={i} className="w-4 h-4 fill-primary text-primary" />
                      ))}
                    </div>
                    
                    <blockquote className="text-lg font-medium leading-relaxed">
                      "{testimonial.quote}"
                    </blockquote>
                    
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-accent flex items-center justify-center text-lg">
                        {testimonial.avatar}
                      </div>
                      <div>
                        <p className="font-semibold">{testimonial.author}</p>
                        <p className="text-sm text-muted-foreground">{testimonial.company}</p>
                      </div>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

// Self-Service Alternative Section
const SelfServiceSection = () => {
  return (
    <section className="flex flex-col items-center justify-center w-full relative">
      <div className="relative w-full px-6">
        <div className="max-w-6xl mx-auto border-l border-r border-border">
          <SectionHeader>
            <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance pb-1">
              Self-Service Alternative
            </h2>
            <p className="text-muted-foreground text-center text-balance font-medium">
              Explore our platform independently with comprehensive resources and community support
            </p>
          </SectionHeader>

          <div className="grid grid-cols-1 md:grid-cols-2 border-t border-border">
            <div className="p-8 border-r border-border space-y-6">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                <TrendingUp className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h3 className="text-xl font-semibold mb-3">Learning Center</h3>
                <p className="text-muted-foreground leading-relaxed mb-4">
                  Master AI worker development through structured courses, detailed documentation, and hands-on tutorials.
                </p>
                <Button variant="outline" className="rounded-full">
                  Start Learning
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            </div>
            
            <div className="p-8 space-y-6">
              <div className="w-12 h-12 rounded-full bg-secondary/10 flex items-center justify-center">
                <Headphones className="w-6 h-6 text-secondary" />
              </div>
              <div>
                <h3 className="text-xl font-semibold mb-3">Developer Community</h3>
                <p className="text-muted-foreground leading-relaxed mb-4">
                  Connect with engineers, solution architects, and other professionals building enterprise AI solutions.
                </p>
                <Button variant="outline" className="rounded-full">
                  Join Community
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

// Final CTA Section
const FinalCTASection = () => {
  return (
    <section className="flex flex-col items-center justify-center w-full relative">
      <div className="relative w-full px-6">
        <div className="max-w-6xl mx-auto border-l border-r border-border">
          <SectionHeader>
            <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance pb-1">
              Ready to Transform Your Operations?
            </h2>
            <p className="text-muted-foreground text-center text-balance font-medium">
              Let's discuss your specific requirements and design a custom AI implementation strategy for your organization.
            </p>
          </SectionHeader>

          <div className="border-t border-border p-8">
            <div className="text-center space-y-6">
              <div className="space-y-4">
                <div className="space-y-6">
                  <KortixEnterpriseModal>
                    <Button size="lg">
                      <Calendar className="w-4 h-4 mr-2" />
                      Book Your Strategy Session
                      <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                  </KortixEnterpriseModal>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-center max-w-2xl mx-auto">
                    <div className="flex flex-col items-center gap-2 p-4 rounded-lg bg-accent/20">
                      <Shield className="w-6 h-6 text-primary" />
                      <span className="text-sm font-medium">100% Satisfaction</span>
                      <span className="text-xs text-muted-foreground">Guarantee</span>
                    </div>
                    <div className="flex flex-col items-center gap-2 p-4 rounded-lg bg-accent/20">
                      <Users className="w-6 h-6 text-primary" />
                      <span className="text-sm font-medium">Enterprise Support</span>
                      <span className="text-xs text-muted-foreground">Dedicated team</span>
                    </div>
                    <div className="flex flex-col items-center gap-2 p-4 rounded-lg bg-accent/20">
                      <Settings className="w-6 h-6 text-primary" />
                      <span className="text-sm font-medium">Custom Pricing</span>
                      <span className="text-xs text-muted-foreground">Tailored to needs</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

// Main Page Component
export default function CustomImplementationPage() {
  return (
    <main className="flex flex-col items-center justify-center min-h-screen w-full">
      <div className="w-full divide-y divide-border">
        <CustomHeroSection />
        <ValuePropSection />
        <ProcessSection />
        <BenefitsSection />
        {/* <TestimonialsSection /> */}
        {/* <SelfServiceSection /> */}
        <FinalCTASection />
        <FooterSection />
      </div>
    </main>
  );
}
