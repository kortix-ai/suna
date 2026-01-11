'use client';

import { SimpleFooter } from '@/components/home/simple-footer';
import { motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

const responsibilities = [
  "Build and maintain the frontend of our platform",
  "Own features from design through implementation",
  "Create animations and interactions that improve the user experience",
  "Work with the team to design interfaces for features",
  "Keep the UI consistent and polished across the product"
];

const qualifications = [
  "Strong frontend skills with React and TypeScript",
  "Good understanding of CSS, including Tailwind and animations",
  "You care about how things look and notice small details",
  "Portfolio showing both technical and design work",
  "Experience shipping polished interfaces"
];

const bonuses = [
  "Experience with Framer Motion or similar animation libraries",
  "Background in graphic design or typography",
  "Experience building or contributing to design systems",
  "Worked on products with real-time or complex interactions"
];

export default function DesignEngineerPage() {
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
                <span className="text-xs font-medium text-foreground">Engineering + Design</span>
              </div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-2xl bg-muted border border-border">
                <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">Remote (Global)</span>
              </div>
            </div>
            
            <h1 className="text-3xl md:text-4xl lg:text-5xl font-medium tracking-tight">
              Design Engineer
            </h1>
            
            <p className="text-lg md:text-xl text-muted-foreground leading-relaxed">
              Frontend engineer who cares about design. You'll own how the product looks and feels, building interfaces that are fast, polished, and easy to use.
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
                We need a frontend engineer who also has a good eye for design. You don't need to be a designer, but you should care about visual quality and user experience.
              </p>
              <p className="text-muted-foreground leading-relaxed">
                You'll work on the interfaces people use to interact with our AI agents. This includes everything from the main chat experience to settings, dashboards, and new features as we build them.
              </p>
              <p className="text-muted-foreground leading-relaxed">
                We're a small team, so you'll have a lot of say in how things look and work. You'll ship often and iterate based on feedback.
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
                  Send us your resume and portfolio. Include any projects that show your work.
                </p>
              </div>
              <Button asChild size="lg">
                <a href="mailto:marko@kortix.com?subject=Design Engineer Application">
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

