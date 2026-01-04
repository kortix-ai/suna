'use client';

import { Mail, Clock, Shield, ChevronDown, UserX } from 'lucide-react';
import { useState, useEffect, useRef, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AnimatedBg } from '@/components/ui/animated-bg';
import { useIsMobile } from '@/hooks/utils';
import { Button } from '@/components/ui/button';

const SectionHeader = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="p-8 space-y-4">
      {children}
    </div>
  );
};

const FAQItem = ({ question, answer }: { question: string; answer: React.ReactNode }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="border-b border-border last:border-0">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full text-left p-6 hover:bg-accent/20 transition-colors flex items-center justify-between gap-4"
      >
        <span className="font-medium">{question}</span>
        <ChevronDown
          className={`w-5 h-5 text-muted-foreground flex-shrink-0 transition-transform ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>
      {isOpen && (
        <div className="px-6 pb-6">
          <div className="text-muted-foreground leading-relaxed">{answer}</div>
        </div>
      )}
    </div>
  );
};

function SupportPageContent() {
  const isMobile = useIsMobile();
  const searchParams = useSearchParams();
  const accountDeleteRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const section = searchParams.get('section');
    if (section === 'account-delete' && accountDeleteRef.current) {
      // Small delay to ensure the page has rendered
      setTimeout(() => {
        accountDeleteRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }, [searchParams]);

  return (
    <main className="flex flex-col items-center justify-center min-h-screen w-full">
      <div className="w-full divide-y divide-border">
        <section className="w-full relative overflow-hidden">
          <AnimatedBg
            variant="hero"
            sizeMultiplier={isMobile ? 0.7 : 1}
            blurMultiplier={isMobile ? 0.6 : 1}
            customArcs={isMobile ? {
              left: [
                {
                  pos: { left: -150, top: 30 },
                  size: 380,
                  tone: 'medium' as const,
                  opacity: 0.15,
                  delay: 0.5,
                  x: [0, 15, -8, 0],
                  y: [0, 12, -6, 0],
                  scale: [0.82, 1.08, 0.94, 0.82],
                  blur: ['12px', '20px', '16px', '12px'],
                },
              ],
              right: [
                {
                  pos: { right: -120, top: 140 },
                  size: 300,
                  tone: 'dark' as const,
                  opacity: 0.2,
                  delay: 1.0,
                  x: [0, -18, 10, 0],
                  y: [0, 14, -8, 0],
                  scale: [0.86, 1.14, 1.0, 0.86],
                  blur: ['10px', '6px', '8px', '10px'],
                },
              ],
            } : undefined}
          />
          <div className="relative flex flex-col items-center w-full px-6">
            <div className="relative z-10 pt-32 mx-auto h-full w-full max-w-6xl flex flex-col items-center justify-center">
              <div className="flex flex-col items-center justify-center gap-6 pt-12 max-w-4xl mx-auto pb-16">
                <div className="mx-auto w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mb-4">
                  <Mail className="w-8 h-8 text-primary" />
                </div>
                
                <h1 className="text-3xl md:text-4xl lg:text-5xl font-medium tracking-tighter text-balance text-center">
                  <span className="text-primary">We're Here to Help</span>
                </h1>
                
                <p className="text-base md:text-lg text-center text-muted-foreground font-medium text-balance leading-relaxed tracking-tight max-w-2xl">
                  Get the support you need from our team. We typically respond within 24 hours on business days.
                </p>

                <div className="flex flex-col sm:flex-row items-center gap-4 pt-4">
                  <Button asChild size="lg" className="text-base h-14 w-48 rounded-full px-8">
                    <a href="mailto:support@kortix.com">
                      <Mail className="w-5 h-5"/>
                      Email Support
                    </a>
                  </Button>
                  <Button asChild variant="outline" size="lg" className="text-base h-14 w-48 rounded-full px-8">
                    <a href="#faq">
                      Browse FAQs
                    </a>
                  </Button>
                </div>

                <p className="text-sm text-muted-foreground">
                  Or email us directly at <a href="mailto:support@kortix.com" className="text-primary hover:underline font-medium">support@kortix.com</a>
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="flex flex-col items-center justify-center w-full relative">
          <div className="relative w-full px-6">
            <div className="max-w-6xl mx-auto border-l border-r border-border">
              <SectionHeader>
                <h2 className="text-2xl md:text-3xl font-medium tracking-tighter text-center text-balance pb-1">
                  Contact Support
                </h2>
                <p className="text-sm text-muted-foreground text-center text-balance font-medium">
                  Multiple ways to get in touch with our team
                </p>
              </SectionHeader>

              <div className="grid grid-cols-1 md:grid-cols-3 border-t border-border">
                <div className="p-8 border-r border-border space-y-4">
                  <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                    <Mail className="w-6 h-6 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold mb-2">Email Support</h3>
                    <p className="text-muted-foreground text-sm mb-4">
                      Send us a detailed message and we'll get back to you as soon as possible.
                    </p>
                    <a 
                      href="mailto:support@kortix.com" 
                      className="text-primary hover:underline font-medium inline-flex items-center gap-2"
                    >
                      support@kortix.com
                    </a>
                  </div>
                </div>

                <div className="p-8 border-r border-border space-y-4">
                  <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                    <Clock className="w-6 h-6 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold mb-2">Response Time</h3>
                    <p className="text-muted-foreground text-sm mb-4">
                      We aim to respond within 24 hours during business days (Monday-Friday).
                    </p>
                    <p className="text-sm font-medium text-muted-foreground">
                      Business Hours: 9 AM - 6 PM CST
                    </p>
                  </div>
                </div>

                <div className="p-8 space-y-4">
                  <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                    <Shield className="w-6 h-6 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold mb-2">Priority Support</h3>
                    <p className="text-muted-foreground text-sm mb-4">
                      Enterprise customers receive priority support with dedicated assistance.
                    </p>
                    <Link href="/enterprise" className="text-primary hover:underline font-medium">
                      Learn more
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="faq" className="flex flex-col items-center justify-center w-full relative">
          <div className="relative w-full px-6">
            <div className="max-w-6xl mx-auto border-l border-r border-border">
              <SectionHeader>
                <h2 className="text-2xl md:text-3xl font-medium tracking-tighter text-center text-balance pb-1">
                  Frequently Asked Questions
                </h2>
                <p className="text-sm text-muted-foreground text-center text-balance font-medium">
                  Find quick answers to common questions
                </p>
              </SectionHeader>

              <div className="border-t border-border">
                <FAQItem
                  question="What is Kortix?"
                  answer="Kortix is a generalist AI worker that can perform real-world tasks on your behalf. Unlike traditional AI assistants, Kortix can actually take action across your apps, automate workflows, and handle complex multi-step tasks autonomously."
                />
                <FAQItem
                  question="How can Kortix help me?"
                  answer="Kortix can automate repetitive tasks, manage your workflows, interact with web services, process data, create content, and coordinate complex operations across multiple platforms. Simply tell Kortix what you need done, and it handles the execution from start to finish."
                />
                <FAQItem
                  question="How is Kortix different from other AI platforms?"
                  answer="While most AI platforms only provide information or suggestions, Kortix actually performs real-world tasks. It can browse the web, interact with APIs, manage files, execute commands, and integrate with your existing tools to complete tasks autonomously—not just tell you how to do them."
                />
                <FAQItem
                  question="Can Kortix connect to my apps?"
                  answer="Yes! Kortix can connect to thousands of apps and services through integrations. It can interact with your tools, APIs, databases, and workflows to automate tasks across your entire tech stack. You control which apps and services Kortix can access."
                />
                <FAQItem
                  question="How do I request a new feature?"
                  answer={
                    <>
                      We love feature requests! Email us at <a href="mailto:support@kortix.com" className="text-primary hover:underline font-medium">support@kortix.com</a> with details about what you'd like to see and how it would help you. We carefully review all suggestions and prioritize features based on user feedback for our product roadmap.
                    </>
                  }
                />
                <FAQItem
                  question="How do I report a bug?"
                  answer={
                    <>
                      If you encounter a bug, please email <a href="mailto:support@kortix.com" className="text-primary hover:underline font-medium">support@kortix.com</a> with a detailed description of the issue, steps to reproduce it, and any error messages you're seeing. Screenshots or screen recordings are extremely helpful. We'll investigate and work on a fix promptly.
                    </>
                  }
                />
                <FAQItem
                  question="What if I don't get credits after paying?"
                  answer={
                    <>
                      If your credits don't appear after payment, contact <a href="mailto:support@kortix.com" className="text-primary hover:underline font-medium">support@kortix.com</a> immediately. We prioritize billing and credit issues for all users regardless of tier and will resolve this as quickly as possible, typically within a few hours during business days.
                    </>
                  }
                />
              </div>
            </div>
          </div>
        </section>

        <section ref={accountDeleteRef} id="account-delete" className="flex flex-col items-center justify-center w-full relative">
          <div className="relative w-full px-6">
            <div className="max-w-6xl mx-auto border-l border-r border-border">
              <SectionHeader>
                <h2 className="text-2xl md:text-3xl font-medium tracking-tighter text-center text-balance pb-1">
                  Account Deletion
                </h2>
                <p className="text-sm text-muted-foreground text-center text-balance font-medium">
                  How to permanently delete your account
                </p>
              </SectionHeader>

              <div className="border-t border-border">
                <div className="p-8 space-y-6">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <UserX className="w-6 h-6 text-primary" />
                    </div>
                    <div className="space-y-4 flex-1">
                      <div>
                        <h3 className="text-lg font-semibold mb-2">Delete Your Account</h3>
                        <p className="text-muted-foreground text-sm leading-relaxed">
                          If you'd like to permanently delete your account, you have two options:
                        </p>
                      </div>

                      <div className="space-y-4">
                        <div className="p-4 rounded-lg border bg-accent/5">
                          <h4 className="font-medium mb-2 text-sm">Option 1: Contact Support</h4>
                          <p className="text-muted-foreground text-sm mb-3">
                            You can request account deletion by contacting our support team. Simply email us at{' '}
                            <a href="mailto:support@kortix.com" className="text-primary hover:underline font-medium">
                              support@kortix.com
                            </a>
                            {' '}with your account deletion request, and we'll process it for you.
                          </p>
                        </div>

                        <div className="p-4 rounded-lg border bg-accent/5">
                          <h4 className="font-medium mb-2 text-sm">Option 2: Self-Delete (When Logged In)</h4>
                          <p className="text-muted-foreground text-sm mb-3">
                            If you're logged into your account, you can delete it yourself through your user settings:
                          </p>
                          <ol className="text-muted-foreground text-sm space-y-2 ml-4 list-decimal">
                            <li>Click on your user avatar/profile picture in the top-right corner of the screen</li>
                            <li>Select <strong className="text-foreground">Settings</strong> from the dropdown menu</li>
                            <li>Scroll down to the <strong className="text-foreground">Delete Account</strong> section</li>
                            <li>Click the <strong className="text-foreground">Delete Account</strong> button</li>
                            <li>Choose your deletion type:
                              <ul className="ml-4 mt-1 space-y-1 list-disc">
                                <li><strong className="text-foreground">30-Day Grace Period:</strong> Your account will be scheduled for deletion in 30 days. You can cancel this request anytime within the grace period.</li>
                                <li><strong className="text-foreground">Immediate Deletion:</strong> Your account and all data will be permanently deleted immediately. This action cannot be undone.</li>
                              </ul>
                            </li>
                            <li>Type <strong className="text-foreground">delete</strong> in the confirmation field</li>
                            <li>Click the final <strong className="text-foreground">Delete Account</strong> button to confirm</li>
                          </ol>
                          <p className="text-muted-foreground text-xs mt-3 italic">
                            Note: When you delete your account, all your agents, threads, credentials, subscriptions, and billing data will be permanently removed. This action cannot be undone after the grace period expires (if you chose the 30-day option) or immediately (if you chose immediate deletion).
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="flex flex-col items-center justify-center w-full relative">
          <div className="relative w-full px-6">
            <div className="max-w-6xl mx-auto border-l border-r border-border">
              <SectionHeader>
                <h2 className="text-2xl md:text-3xl font-medium tracking-tighter text-center text-balance pb-1">
                  Legal Information
                </h2>
                <p className="text-sm text-muted-foreground text-center text-balance font-medium">
                  Transparency and compliance documentation
                </p>
              </SectionHeader>

              <div className="grid grid-cols-1 md:grid-cols-3 border-t border-border">
                <div className="p-8 border-r border-border space-y-4">
                  <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                    <Shield className="w-6 h-6 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold mb-2">Terms of Service</h3>
                    <p className="text-muted-foreground text-sm mb-4">
                      Our terms and conditions for using Kortix services, including user responsibilities and service limitations.
                    </p>
                    <Link href="/legal?tab=terms" className="text-primary hover:underline font-medium text-sm">
                      Read Terms →
                    </Link>
                  </div>
                </div>

                <div className="p-8 border-r border-border space-y-4">
                  <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                    <Shield className="w-6 h-6 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold mb-2">Privacy Policy</h3>
                    <p className="text-muted-foreground text-sm mb-4">
                      How we collect, use, and protect your personal information. We're committed to data privacy and security.
                    </p>
                    <Link href="/legal?tab=privacy" className="text-primary hover:underline font-medium text-sm">
                      Read Policy →
                    </Link>
                  </div>
                </div>

                <div className="p-8 space-y-4">
                  <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                    <Shield className="w-6 h-6 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold mb-2">Imprint</h3>
                    <p className="text-muted-foreground text-sm mb-4">
                      Company information and legal details about Kortix AI Corp, including contact information and registration.
                    </p>
                    <Link href="/legal?tab=imprint" className="text-primary hover:underline font-medium text-sm">
                      View Imprint →
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="flex flex-col items-center justify-center w-full relative">
          <div className="relative w-full px-6 py-16">
            <div className="max-w-4xl mx-auto text-center space-y-6">
              <h2 className="text-2xl md:text-3xl font-medium tracking-tighter text-balance">
                Still Have Questions?
              </h2>
              <p className="text-sm text-muted-foreground text-balance font-medium">
                Our support team is ready to help you with any questions or issues you may have.
              </p>
              <div className="pt-4">
                <Button asChild size="lg" className="text-base h-14 w-48 rounded-full px-8">
                  <a href="mailto:support@kortix.com">
                    <Mail className="w-5 h-5" />
                    Contact Support
                  </a>
                </Button>
              </div>
              <div className="pt-6 space-y-2">
                <p className="text-sm text-muted-foreground">
                  General Inquiries: <a href="mailto:info@kortix.com" className="text-primary hover:underline">info@kortix.com</a>
                </p>
                <p className="text-sm text-muted-foreground">
                  Security Issues: <a href="mailto:security@kortix.com" className="text-primary hover:underline">security@kortix.com</a>
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

export default function SupportPage() {
  return (
    <Suspense fallback={
      <main className="flex flex-col items-center justify-center min-h-screen w-full">
        <div className="w-full">
          <div className="flex flex-col items-center justify-center min-h-screen">
            <div className="text-muted-foreground">Loading...</div>
          </div>
        </div>
      </main>
    }>
      <SupportPageContent />
    </Suspense>
  );
}
