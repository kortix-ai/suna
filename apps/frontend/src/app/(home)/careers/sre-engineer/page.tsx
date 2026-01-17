'use client';

import { SimpleFooter } from '@/components/home/simple-footer';
import { motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

const responsibilities = [
  "Build and maintain infrastructure on AWS ECS and related services",
  "Manage and optimize Supabase (PostgreSQL) for performance and reliability",
  "Design and implement CI/CD pipelines with GitHub Actions for fast deployments",
  "Set up monitoring, alerting, and observability across all services",
  "Optimize application and infrastructure performance for scale",
  "Ensure system reliability with a target of 99.99% uptime",
  "Review code for scalability and performance issues",
  "Automate infrastructure provisioning and management",
  "Respond to incidents and conduct post-mortems to prevent recurrence"
];

const qualifications = [
  "Strong experience with AWS ECS and container orchestration",
  "Proficient with Supabase or PostgreSQL performance tuning and optimization",
  "Experience building and maintaining CI/CD pipelines with GitHub Actions",
  "Solid understanding of containerization with Docker",
  "Experience with monitoring and observability tools (Datadog, Prometheus, Grafana, CloudWatch)",
  "Comfortable debugging production issues under pressure",
  "Strong scripting skills (Python, Bash, or similar)"
];

const bonuses = [
  "Experience scaling ECS services to handle high traffic",
  "Background in security best practices and compliance",
  "Experience with AWS cost optimization",
  "Deep knowledge of PostgreSQL and Redis optimization",
  "Experience with infrastructure-as-code (Terraform, CloudFormation)",
  "Open source contributions to infrastructure tools"
];

export default function SREEngineerPage() {
  return (
    <main className="min-h-screen bg-background">
      {/* Back Link */}
      <div className="max-w-3xl mx-auto px-6 md:px-10 pt-24 md:pt-28">
        <Link 
          href="/careers" 
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          All positions
        </Link>
      </div>

      {/* Hero Section */}
      <section className="relative overflow-hidden">
        <div className="max-w-3xl mx-auto px-6 md:px-10 pt-8 pb-16 md:pb-20">
          <motion.div
            className="space-y-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="flex items-center gap-3 flex-wrap">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-2xl bg-muted border border-border">
                <span className="text-xs font-medium text-foreground">Infrastructure</span>
              </div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-2xl bg-muted border border-border">
                <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">Nomadic / Global</span>
              </div>
            </div>
            
            <h1 className="text-3xl md:text-4xl lg:text-5xl font-medium tracking-tight">
              Infrastructure / SRE Engineer
            </h1>
            
            <p className="text-lg md:text-xl text-muted-foreground leading-relaxed">
              Make sure everything scales and stays rock solid. You'll own our infrastructure, optimize our systems, and keep us running at 99.99% uptime.
            </p>
          </motion.div>
        </div>
      </section>

      {/* About the Role */}
      <section className="border-t border-border">
        <div className="max-w-3xl mx-auto px-6 md:px-10 py-16 md:py-20">
          <motion.div
            className="space-y-6"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
          >
            <h2 className="text-xl md:text-2xl font-medium tracking-tight">
              About the role
            </h2>
            <div className="prose prose-neutral dark:prose-invert max-w-none">
              <p className="text-muted-foreground leading-relaxed">
                We're building AI agents that handle real work at scale. We need someone to make sure our infrastructure can keep up as we grow.
              </p>
              <p className="text-muted-foreground leading-relaxed">
                You'll work across the stack, from optimizing application code for performance to architecting our AWS infrastructure. CI/CD, monitoring, alerting, observability—you'll own it all. When something breaks, you'll be the one who figures out why and makes sure it doesn't happen again.
              </p>
              <p className="text-muted-foreground leading-relaxed">
                Small team, big impact. You'll have significant ownership over how we scale.
              </p>
            </div>
          </motion.div>
        </div>
      </section>

      {/* What You'll Do */}
      <section className="border-t border-border">
        <div className="max-w-3xl mx-auto px-6 md:px-10 py-16 md:py-20">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
          >
            <h2 className="text-xl md:text-2xl font-medium tracking-tight mb-8">
              What you'll do
            </h2>
            <ul className="space-y-4">
              {responsibilities.map((item, index) => (
                <motion.li
                  key={index}
                  className="flex items-start gap-3"
                  initial={{ opacity: 0, x: -10 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.4, delay: index * 0.05 }}
                  viewport={{ once: true }}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-foreground mt-2.5 flex-shrink-0" />
                  <span className="text-muted-foreground">{item}</span>
                </motion.li>
              ))}
            </ul>
          </motion.div>
        </div>
      </section>

      {/* What We're Looking For */}
      <section className="border-t border-border">
        <div className="max-w-3xl mx-auto px-6 md:px-10 py-16 md:py-20">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
          >
            <h2 className="text-xl md:text-2xl font-medium tracking-tight mb-8">
              What we're looking for
            </h2>
            <ul className="space-y-4">
              {qualifications.map((item, index) => (
                <motion.li
                  key={index}
                  className="flex items-start gap-3"
                  initial={{ opacity: 0, x: -10 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.4, delay: index * 0.05 }}
                  viewport={{ once: true }}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-foreground mt-2.5 flex-shrink-0" />
                  <span className="text-muted-foreground">{item}</span>
                </motion.li>
              ))}
            </ul>
          </motion.div>
        </div>
      </section>

      {/* Bonus Points */}
      <section className="border-t border-border">
        <div className="max-w-3xl mx-auto px-6 md:px-10 py-16 md:py-20">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
          >
            <h2 className="text-xl md:text-2xl font-medium tracking-tight mb-8">
              Bonus points
            </h2>
            <ul className="space-y-4">
              {bonuses.map((item, index) => (
                <motion.li
                  key={index}
                  className="flex items-start gap-3"
                  initial={{ opacity: 0, x: -10 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.4, delay: index * 0.05 }}
                  viewport={{ once: true }}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-foreground mt-2.5 flex-shrink-0" />
                  <span className="text-muted-foreground">{item}</span>
                </motion.li>
              ))}
            </ul>
          </motion.div>
        </div>
      </section>

      {/* Apply CTA */}
      <section className="border-t border-border">
        <div className="max-w-3xl mx-auto px-6 md:px-10 py-16 md:py-20">
          <motion.div
            className="p-8 md:p-10 rounded-2xl bg-muted/50 border border-border"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
          >
            <div className="space-y-6">
              <div>
                <h2 className="text-xl md:text-2xl font-medium tracking-tight mb-3">
                  Interested?
                </h2>
                <p className="text-muted-foreground">
                  Send us your resume and a short note about yourself. Include any relevant projects or work.
                </p>
              </div>
              <Button asChild size="lg">
                <a href="mailto:marko@kortix.com?subject=Infrastructure / SRE Engineer Application">
                  Apply now
                  <ArrowRight className="w-4 h-4 ml-2" />
                </a>
              </Button>
            </div>
          </motion.div>
        </div>
      </section>

      <SimpleFooter />
    </main>
  );
}
