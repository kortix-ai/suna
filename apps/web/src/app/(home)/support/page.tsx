'use client';

import { cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';
import { useState, useEffect, useRef, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Reveal } from '@/components/home/reveal';

function FAQItem({ question, answer }: { question: string; answer: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="border-b border-border last:border-0">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full text-left py-5 flex items-center justify-between gap-4 cursor-pointer"
      >
        <span className="text-base text-foreground">{question}</span>
        <ChevronDown
          className={cn('size-4 text-muted-foreground shrink-0 transition-transform duration-200', 
            isOpen ? 'rotate-180' : ''
          )}
        />
      </button>
      {isOpen && (
        <div className="pb-5">
          <div className="text-sm text-muted-foreground leading-relaxed">{answer}</div>
        </div>
      )}
    </div>
  );
}

function SupportPageContent() {
  const searchParams = useSearchParams();
  const accountDeleteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const section = searchParams.get('section');
    if (section === 'account-delete' && accountDeleteRef.current) {
      setTimeout(() => {
        accountDeleteRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }, [searchParams]);

  const linkClass = 'text-foreground hover:text-foreground underline underline-offset-4 decoration-foreground/20 hover:decoration-foreground/50 transition-colors';

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-6 pt-24 sm:pt-32 pb-24 sm:pb-32">

        {/* Hero */}
        <Reveal>
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-medium tracking-tight text-foreground mb-3">
            Support
          </h1>
        </Reveal>
        <Reveal delay={0.08}>
          <p className="text-base text-muted-foreground leading-relaxed max-w-xl">
            Email us at{' '}
            <a href="mailto:support@kortix.com" className={linkClass}>support@kortix.com</a>.
            {' '}We typically respond within 24 hours on business days.
          </p>
        </Reveal>

        {/* FAQ */}
        <Reveal>
          <div className="mt-14">
            <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">
              Frequently Asked Questions
            </h2>
            <div>
              <FAQItem
                question="What is Kortix?"
                answer="A 24/7 cloud computer where AI agents do the actual work of running a company. You connect your tools, define your agents, set their schedules and triggers — and the machine operates whether you're there or not."
              />
              <FAQItem
                question="How is Kortix different from other AI platforms?"
                answer="Most AI platforms are chat interfaces that give you suggestions. Kortix is a persistent computer that runs agents autonomously — they browse the web, execute code, call APIs, manage files, and coordinate across your tools. They work while you sleep."
              />
              <FAQItem
                question="Can Kortix connect to my apps?"
                answer="Yes. 3,000+ integrations via OAuth, MCP servers, REST APIs, CLI tools, and environment variables. If it has an interface, Kortix connects to it."
              />
              <FAQItem
                question="How do I request a feature or report a bug?"
                answer={
                  <>Email <a href="mailto:support@kortix.com" className={linkClass}>support@kortix.com</a> with details. For bugs, include steps to reproduce and any error messages. Screenshots help.</>
                }
              />
              <FAQItem
                question="What if I don't get credits after paying?"
                answer={
                  <>Contact <a href="mailto:support@kortix.com" className={linkClass}>support@kortix.com</a> immediately. We prioritize billing issues and typically resolve them within a few hours.</>
                }
              />
            </div>
          </div>
        </Reveal>

        {/* Account Deletion */}
        <Reveal>
          <div ref={accountDeleteRef} id="account-delete" className="mt-14">
            <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">
              Account Deletion
            </h2>
            <p className="text-base text-muted-foreground leading-relaxed mb-4">
              To delete your account, either email{' '}
              <a href="mailto:support@kortix.com" className={linkClass}>support@kortix.com</a>
              {' '}or do it yourself from settings:
            </p>
            <ol className="text-sm text-muted-foreground leading-relaxed space-y-2 list-decimal ml-4">
              <li>Click your avatar → Settings</li>
              <li>Scroll to Delete Account</li>
              <li>Choose 14-day grace period or immediate deletion</li>
              <li>Type &quot;delete&quot; to confirm</li>
            </ol>
            <p className="text-xs text-muted-foreground mt-4">
              All agents, sessions, credentials, and billing data will be permanently removed. This cannot be undone.
            </p>
          </div>
        </Reveal>

        {/* Legal */}
        <Reveal>
          <div className="mt-14">
            <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">
              Legal
            </h2>
            <div className="flex flex-col gap-1.5">
              <Link href="/legal?tab=terms" className={`text-base ${linkClass} w-fit`}>
                Terms of Service
              </Link>
              <Link href="/legal?tab=privacy" className={`text-base ${linkClass} w-fit`}>
                Privacy Policy
              </Link>
              <Link href="/legal?tab=imprint" className={`text-base ${linkClass} w-fit`}>
                Imprint
              </Link>
            </div>
          </div>
        </Reveal>

        {/* Contact */}
        <Reveal>
          <div className="mt-14 pt-8 border-t border-border">
            <p className="text-base text-muted-foreground leading-relaxed">
              Still need help? Reach out.
            </p>
            <div className="flex flex-col gap-1.5 mt-3">
              <a href="mailto:support@kortix.com" className={`text-base ${linkClass} w-fit`}>
                support@kortix.com
              </a>
              <a href="mailto:security@kortix.com" className={`text-base ${linkClass} w-fit`}>
                security@kortix.com
              </a>
            </div>
          </div>
        </Reveal>

      </div>
    </main>
  );
}

export default function SupportPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen bg-background">
        <div className="max-w-3xl mx-auto px-6 pt-24 sm:pt-32">
          <div className="text-sm text-muted-foreground">Loading...</div>
        </div>
      </main>
    }>
      <SupportPageContent />
    </Suspense>
  );
}
