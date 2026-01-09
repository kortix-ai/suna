'use client';

import { SimpleFooter } from '@/components/home/simple-footer';
import { motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

const responsibilities = [
  'Own reliability and scalability across our production stack (Python/FastAPI, Postgres, AWS)',
  'Define and drive SLOs/SLIs, alerting, on-call, incident response, and postmortems',
  'Build observability that actually helps: metrics, logs, tracing, dashboards, and runbooks',
  'Harden deployments and pipelines (CI/CD), reduce risk, and make releases boring',
  'Design capacity and cost strategy—keep us fast, stable, and efficient as we grow',
  'Partner with engineering to unblock performance work (API latency, DB tuning, caching, queues)',
  'Level up our security posture (least privilege, secrets, network boundaries, backups)',
  'Mentor and set standards for infrastructure and operational excellence',
];

const qualifications = [
  'Proven track record running production systems at scale (SRE, Infra, Platform, or similar)',
  'Strong AWS fundamentals (networking, IAM, compute, databases, observability)',
  'Hands-on experience with Postgres reliability and performance (backups, replication, tuning)',
  'Comfortable deep in the weeds: debugging latency, outages, and tricky failure modes',
  'Strong automation mindset (IaC, repeatable environments, reliable deploys)',
  'Clear communicator—can lead incidents, write crisp postmortems, and drive follow-ups',
];

const bonuses = [
  'Experience with Kubernetes/EKS or ECS, Terraform, and modern platform tooling',
  'Background in Python services (FastAPI), async systems, and performance profiling',
  'Experience building internal platforms or developer experience (DX) tooling',
  'Security-minded: threat modeling, audits, and pragmatic hardening',
];

export default function InfraSiteReliabilityManagerPage() {
  if (process.env.NODE_ENV === 'development') {
    console.log('[InfraSiteReliabilityManagerPage] role data', {
      responsibilities,
      qualifications,
      bonuses,
    });
  }

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
                <span className="text-xs font-medium text-muted-foreground">Remote (Global)</span>
              </div>
            </div>

            <h1 className="text-3xl md:text-4xl lg:text-5xl font-medium tracking-tight">
              Infra / Site Reliability Manager
            </h1>

            <p className="text-lg md:text-xl text-muted-foreground leading-relaxed">
              Make sure our stack scales. You’ll own reliability and performance across our Python/FastAPI +
              Postgres systems on AWS—so we can ship fast without breaking things.
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
            <h2 className="text-xl md:text-2xl font-medium tracking-tight">About the role</h2>
            <div className="prose prose-neutral dark:prose-invert max-w-none">
              <p className="text-muted-foreground leading-relaxed">
                We’re building AI workers that run real workloads for real businesses. That means reliability
                isn’t a “later” problem—it’s a product feature.
              </p>
              <p className="text-muted-foreground leading-relaxed">
                As our Infra / Site Reliability Manager, you’ll turn our infrastructure into a lever: stable,
                observable, secure, and scalable. You’ll partner with engineering to prevent incidents, respond
                quickly when they happen, and continuously reduce operational overhead.
              </p>
              <p className="text-muted-foreground leading-relaxed">
                If you love hard systems problems, hate flaky deploys, and can lead calmly through chaos, you’ll
                fit right in.
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
            <h2 className="text-xl md:text-2xl font-medium tracking-tight mb-8">What you&apos;ll do</h2>
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
            <h2 className="text-xl md:text-2xl font-medium tracking-tight mb-8">What we&apos;re looking for</h2>
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
            <h2 className="text-xl md:text-2xl font-medium tracking-tight mb-8">Bonus points</h2>
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
                  Ready to make it scale?
                </h2>
                <p className="text-muted-foreground">
                  Send us your resume and a few lines about what you’ve built, operated, and improved at scale.
                </p>
              </div>
              <Button asChild size="lg">
                <a href="mailto:careers@kortix.ai?subject=Infra%20%2F%20Site%20Reliability%20Manager%20Application">
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

