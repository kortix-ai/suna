'use client';

import { SimpleFooter } from '@/components/home/simple-footer';
import { motion } from 'framer-motion';
import { ArrowRight, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

const values = [
  {
    title: "Speed matters",
    description: "We ship often. If something isn't working, we'd rather find out now than in three months."
  },
  {
    title: "Say what you think",
    description: "Good ideas can come from anyone. We argue, disagree, and figure things out together."
  },
  {
    title: "Build for the long run",
    description: "We're not interested in hype. We want to build something that's still useful in ten years."
  },
  {
    title: "Work from anywhere",
    description: "No office, no set hours. Just get your work done and be online when it matters."
  }
];

const openings = [
  {
    title: "AI Engineer",
    location: "Remote",
    description: "You'll work on our AI agents, making them reliable, fast, and actually useful. Experience with LLMs and building AI products required.",
    href: "/careers/ai-engineer",
  },
  {
    title: "Design Engineer",
    location: "Remote",
    description: "Frontend engineer who cares about design. You'll own how things look and feel across the product.",
    href: "/careers/design-engineer",
  }
];

export default function CareersPage() {
  return (
    <main className="min-h-screen bg-background">
      {/* Hero Section */}
      <section className="relative overflow-hidden">
        <div className="max-w-4xl mx-auto px-6 md:px-10 pt-32 md:pt-40 pb-20 md:pb-28">
          <motion.div
            className="space-y-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-2xl bg-muted border border-border">
              <span className="text-sm font-medium text-foreground">We're hiring</span>
            </div>
            
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-medium tracking-tight text-balance">
              Work with us
            </h1>
            
            <p className="text-foreground text-[1.375rem] md:text-[1.5rem] leading-[1.6] tracking-[-0.025em] font-medium max-w-2xl opacity-50">
              Small team, big problem. We're building AI that can take over real work. 
              Fully remote, flexible hours, and we travel together a few times a year.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Values Section */}
      <section className="border-t border-border">
        <div className="max-w-4xl mx-auto px-6 md:px-10 py-20 md:py-28">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
          >
            <h2 className="text-2xl md:text-3xl font-medium tracking-tight mb-12">
              How we work
            </h2>
          </motion.div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12">
            {values.map((value, index) => (
              <motion.div
                key={index}
                className="space-y-3"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                viewport={{ once: true }}
              >
                <h3 className="text-lg font-semibold">{value.title}</h3>
                <p className="text-muted-foreground leading-relaxed">{value.description}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Open Positions */}
      <section className="border-t border-border">
        <div className="max-w-4xl mx-auto px-6 md:px-10 py-20 md:py-28">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
          >
            <h2 className="text-2xl md:text-3xl font-medium tracking-tight mb-4">
              Open positions
            </h2>
            <p className="text-muted-foreground mb-12">
              If you're good at what you do, we'd like to talk.
            </p>
          </motion.div>

          <div className="space-y-4">
            {openings.map((job, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                viewport={{ once: true }}
              >
                <Link
                  href={job.href}
                  className="group block p-6 rounded-2xl border border-border bg-card hover:bg-accent/50 hover:border-foreground/20 transition-all duration-300"
                >
                  <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                    <div className="space-y-2">
                      <h3 className="text-lg font-semibold group-hover:text-foreground transition-colors">
                        {job.title}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {job.description}
                      </p>
                      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <MapPin className="w-3.5 h-3.5" />
                        {job.location}
                      </div>
                    </div>
                    <div className="flex-shrink-0 md:mt-1">
                      <div className="inline-flex items-center gap-2 text-sm font-medium text-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                        View role
                        <ArrowRight className="w-4 h-4" />
                      </div>
                    </div>
                  </div>
                </Link>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="border-t border-border">
        <div className="max-w-4xl mx-auto px-6 md:px-10 py-20 md:py-28">
          <motion.div
            className="text-center space-y-6"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
          >
            <h2 className="text-2xl md:text-3xl font-medium tracking-tight">
              Don't see your role?
            </h2>
            <p className="text-muted-foreground max-w-xl mx-auto">
              We're always looking for exceptional people. If you're passionate about AI and want to join our team, reach out.
            </p>
            <div className="pt-4">
              <Button asChild size="lg" variant="outline">
                <a href="mailto:marko@kortix.com">
                  Get in touch
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

