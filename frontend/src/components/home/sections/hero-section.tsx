'use client';
import { HeroVideoSection } from '@/components/home/sections/hero-video-section';
import { siteConfig } from '@/lib/home';
import { ArrowRight, X, AlertCircle, Sparkles } from 'lucide-react';
import { GradientText } from '@/components/animate-ui/text/gradient';
import { FlickeringGrid } from '@/components/home/ui/flickering-grid';
import { LampContainer } from '@/components/ui/lamp';
import { FlipWords } from '@/components/ui/flip-words';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useState, useEffect, useRef, FormEvent } from 'react';
import { useScroll, motion } from 'motion/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import {
  BillingError,
} from '@/lib/api';
import { useInitiateAgentMutation } from '@/hooks/react-query/dashboard/use-initiate-agent';
import { useThreadQuery } from '@/hooks/react-query/threads/use-threads';
import { generateThreadName } from '@/lib/actions/threads';
import GoogleSignIn from '@/components/GoogleSignIn';
import MicrosoftSignIn from '@/components/MicrosoftSignIn';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogOverlay,
} from '@/components/ui/dialog';
import { BillingErrorAlert } from '@/components/billing/usage-limit-alert';
import { useBillingError } from '@/hooks/useBillingError';
import { useAccounts } from '@/hooks/use-accounts';
import { isLocalMode, config } from '@/lib/config';
import { toast } from 'sonner';
import { useModal } from '@/hooks/use-modal-store';
import { createClient } from '@/lib/supabase/client';

// Custom dialog overlay with blur effect
const BlurredDialogOverlay = () => (
  <DialogOverlay className="bg-background/40 backdrop-blur-md" />
);

// Constant for localStorage key to ensure consistency
const PENDING_PROMPT_KEY = 'pendingAgentPrompt';

export function HeroSection() {
  const { hero } = siteConfig;
  const tablet = useMediaQuery('(max-width: 1024px)');
  const [mounted, setMounted] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const scrollTimeout = useRef<NodeJS.Timeout | null>(null);
  const { scrollY } = useScroll();
  const [inputValue, setInputValue] = useState('');
  const router = useRouter();
  const { user, isLoading } = useAuth();
  const { billingError, handleBillingError, clearBillingError } =
    useBillingError();
  const { data: accounts } = useAccounts();
  const personalAccount = accounts?.find((account) => account.personal_account);
  const { onOpen } = useModal();
  const initiateAgentMutation = useInitiateAgentMutation();
  const [initiatedThreadId, setInitiatedThreadId] = useState<string | null>(null);
  const threadQuery = useThreadQuery(initiatedThreadId || '');

  // Auth dialog state
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // FlipWords arrays for value proposition
  const moreWords = ["research", "analysis", "automation", "productivity", "insights", "results", "growth", "efficiency"];
  const lessWords = ["effort", "time", "work", "stress", "cost", "manual work", "overhead", "resources"];

  useEffect(() => {
    setMounted(true);
    
    // Detect Safari browser
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    if (isSafari) {
      document.documentElement.classList.add('is-safari');
    }
    
    // Inject critical CSS immediately to prevent gray border flash
    // Safari requires extensive border overrides due to:
    // 1. Different handling of CSS custom properties in shadow DOM
    // 2. Border inheritance issues with Tailwind classes
    // 3. WebKit-specific rendering of border styles
    // 4. Issues with border: 0 vs border: none specificity
    const style = document.createElement('style');
    style.textContent = `
      /* Emergency CSS to prevent gray borders */
      #hero,
      #hero *,
      #hero *::before,
      #hero *::after,
      [data-hero-element],
      [data-hero-element]::before,
      [data-hero-element]::after {
        border: 0 !important;
        border-color: transparent !important;
        outline: none !important;
      }
      
      /* Specifically override global border color CSS variables in hero section */
      #hero {
        --border: transparent !important;
        --input: transparent !important;
        --ring: transparent !important;
        --border-border: transparent !important;
      }
      
      /* Force transparent borders on all potential border elements */
      #hero .border,
      #hero .border-t,
      #hero .border-r,
      #hero .border-b,
      #hero .border-l,
      #hero .border-x,
      #hero .border-y,
      #hero .border-input,
      #hero [class*="border-"],
      #hero [class*="border "],
      #hero [class*=" border"] {
        border-color: transparent !important;
      }
      
      /* Ensure motion divs have no borders */
      #hero div[style*="transform"] {
        border: 0 !important;
        border-color: transparent !important;
      }
      
      /* Safari-specific fixes */
      @supports (-webkit-appearance: none) {
        #hero,
        #hero * {
          border: 0 !important;
          border-color: transparent !important;
          -webkit-border-before: none !important;
          -webkit-border-after: none !important;
          -webkit-border-start: none !important;
          -webkit-border-end: none !important;
        }
        
        #hero input,
        #hero input[type="text"],
        #hero .hero-input {
          border: 0 !important;
          border-color: transparent !important;
          -webkit-appearance: none !important;
          -webkit-border-before: none !important;
          -webkit-border-after: none !important;
          -webkit-border-start: none !important;
          -webkit-border-end: none !important;
          background-clip: padding-box !important;
          -webkit-background-clip: padding-box !important;
        }
        
        /* Force Safari to respect transparent borders */
        #hero [class*="border"],
        #hero [class*="border-"] {
          border-image: none !important;
          border-style: solid !important;
          border-color: transparent !important;
          border-width: 0 !important;
        }
      }
      
      /* Additional Safari mobile fixes */
      @supports (-webkit-touch-callout: none) {
        #hero input {
          -webkit-user-select: text !important;
          -webkit-touch-callout: default !important;
          border: 0 !important;
          outline: 0 !important;
        }
      }
      
      /* Safari-specific data attribute targeting */
      @supports (-webkit-appearance: none) {
        #hero [data-safari-fix="true"] {
          border: 1px solid rgba(34, 211, 238, 0.3) !important;
          border-width: 1px !important;
          border-style: solid !important;
          border-color: rgba(34, 211, 238, 0.3) !important;
        }
        
        #hero [data-safari-fix="true"] * {
          border: none !important;
          border-style: none !important;
          border-width: 0 !important;
          border-color: transparent !important;
        }
      }
      
      /* Hero input container with cyan glow border */
      #hero .hero-input-container {
        border: 1px solid rgba(34, 211, 238, 0.3) !important;
      }
      
      /* Safari browser class targeting */
      .is-safari #hero,
      .is-safari #hero * {
        border: none !important;
        border-style: none !important;
        border-width: 0 !important;
        border-color: transparent !important;
        border-image: none !important;
      }
      
      .is-safari #hero .hero-input-container {
        border: 1px solid rgba(34, 211, 238, 0.3) !important;
        border-width: 1px !important;
        border-style: solid !important;
        border-color: rgba(34, 211, 238, 0.3) !important;
      }
      
      .is-safari #hero input {
        border: none !important;
        border-style: none !important;
        border-width: 0 !important;
        border-color: transparent !important;
        -webkit-appearance: none !important;
      }
    `;
    style.id = 'hero-critical-css';
    
    // Insert at the very beginning of head
    const firstChild = document.head.firstChild;
    if (firstChild) {
      document.head.insertBefore(style, firstChild);
    } else {
      document.head.appendChild(style);
    }
    
    // Add 'loaded' class after a short delay to re-enable transitions
    const heroSection = document.getElementById('hero');
    if (heroSection) {
      setTimeout(() => {
        heroSection.classList.add('loaded');
      }, 100);
    }
    
    // Cleanup on unmount
    return () => {
      const styleEl = document.getElementById('hero-critical-css');
      if (styleEl) {
        styleEl.remove();
      }
      // Remove Safari class
      document.documentElement.classList.remove('is-safari');
    };
  }, []);

  // Detect when scrolling is active to reduce animation complexity
  useEffect(() => {
    const unsubscribe = scrollY.on('change', () => {
      setIsScrolling(true);

      // Clear any existing timeout
      if (scrollTimeout.current) {
        clearTimeout(scrollTimeout.current);
      }

      // Set a new timeout
      scrollTimeout.current = setTimeout(() => {
        setIsScrolling(false);
      }, 300); // Wait 300ms after scroll stops
    });

    return () => {
      unsubscribe();
      if (scrollTimeout.current) {
        clearTimeout(scrollTimeout.current);
      }
    };
  }, [scrollY]);

  useEffect(() => {
    if (authDialogOpen && inputValue.trim()) {
      localStorage.setItem(PENDING_PROMPT_KEY, inputValue.trim());
    }
  }, [authDialogOpen, inputValue]);

  useEffect(() => {
    if (authDialogOpen && user && !isLoading) {
      setAuthDialogOpen(false);
      router.push('/dashboard');
    }
  }, [user, isLoading, authDialogOpen, router]);

  useEffect(() => {
    if (threadQuery.data && initiatedThreadId) {
      const thread = threadQuery.data;
      if (thread.project_id) {
        router.push(`/projects/${thread.project_id}/thread/${initiatedThreadId}`);
      } else {
        router.push(`/thread/${initiatedThreadId}`);
      }
      setInitiatedThreadId(null);
    }
  }, [threadQuery.data, initiatedThreadId, router]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!inputValue.trim()) return;

    setIsSubmitting(true);
    setAuthError(null);

    try {
      // If not authenticated, show auth dialog
      if (!user) {
        localStorage.setItem(PENDING_PROMPT_KEY, inputValue.trim());
        setAuthDialogOpen(true);
        return;
      }

      // If authenticated, proceed with agent creation
      const formData = new FormData();
      formData.append('prompt', inputValue.trim());
      formData.append('stream', 'true');
      
      const result = await initiateAgentMutation.mutateAsync(formData);

      if (result.thread_id) {
        setInitiatedThreadId(result.thread_id);
        setInputValue('');
        router.push(`/agents/${result.thread_id}`);
      } else {
        throw new Error('Failed to create agent');
      }
    } catch (error: any) {
      console.error('Error in handleSubmit:', error);
      
      if (error?.name === 'BillingError') {
        handleBillingError(error as BillingError);
      } else {
        const errorMessage = error?.message || 'An unexpected error occurred';
        toast.error(errorMessage);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit(e as any);
    }
  };

  const handleSignIn = async (prevState: any, formData: FormData) => {
    setAuthError(null);
    
    try {
      const email = formData.get('email') as string;
      const password = formData.get('password') as string;
      
      if (!email || !email.includes('@')) {
        setAuthError('Please enter a valid email address');
        return;
      }

      if (!password || password.length < 6) {
        setAuthError('Password must be at least 6 characters');
        return;
      }

      const supabase = createClient();

      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        setAuthError(error.message || 'Could not authenticate user');
        return;
      }

      // Authentication successful - the auth state change will be handled by useEffect
      // and will redirect to dashboard
      
    } catch (error: any) {
      console.error('Sign in error:', error);
      setAuthError(error.message || 'Failed to sign in');
    }
  };

  return (
    <section id="hero" className="w-full relative overflow-hidden min-h-[100svh] flex items-center justify-center">
      {/* Immediate inline styles to prevent FOUC */}
      <link 
        rel="stylesheet" 
        href={`data:text/css,${encodeURIComponent(`
          /* Override CSS variables for hero section */
          #hero {
            --border: transparent !important;
            --input: transparent !important;
            --ring: transparent !important;
            --border-border: transparent !important;
          }
          
          /* Reset all element borders in hero section */
          #hero,
          #hero *,
          #hero *::before,
          #hero *::after {
            border: 0 !important;
            border-color: transparent !important;
            outline: none !important;
            box-shadow: none !important;
          }
          
          /* Prevent any Tailwind border classes from applying */
          #hero .border,
          #hero .border-t,
          #hero .border-r,
          #hero .border-b,
          #hero .border-l,
          #hero .border-x,
          #hero .border-y,
          #hero .border-input,
          #hero [class*="border-"],
          #hero [class*="border "],
          #hero [class*=" border"] {
            border-color: transparent !important;
          }
          
          /* Override input specific styles */
          #hero input,
          #hero input:focus,
          #hero input:hover,
          #hero input:active {
            border: 0 !important;
            border-color: transparent !important;
            outline: none !important;
            box-shadow: none !important;
          }
          
          /* Safari-specific fixes */
          @supports (-webkit-appearance: none) {
            #hero,
            #hero * {
              border: none !important;
              border-style: none !important;
              border-width: 0 !important;
              border-color: transparent !important;
              -webkit-border-before: none !important;
              -webkit-border-after: none !important;
              -webkit-border-start: none !important;
              -webkit-border-end: none !important;
            }
            
            #hero input {
              -webkit-appearance: none !important;
              border: none !important;
              border-style: none !important;
              border-width: 0 !important;
              border-color: transparent !important;
              -webkit-tap-highlight-color: transparent !important;
            }
          }
          
          #hero .hero-input-container {
            border: 1px solid rgba(34, 211, 238, 0.3) !important;
            border-radius: 9999px !important;
            background-color: rgba(255, 255, 255, 0.1) !important;
            backdrop-filter: blur(12px) !important;
            -webkit-backdrop-filter: blur(12px) !important;
          }
          
          /* Safari input container override */
          @supports (-webkit-appearance: none) {
            #hero .hero-input-container {
              border: 1px solid rgba(34, 211, 238, 0.3) !important;
              border-width: 1px !important;
              border-style: solid !important;
              border-color: rgba(34, 211, 238, 0.3) !important;
            }
          }
          
          @media (prefers-color-scheme: dark) {
            #hero .hero-input-container {
              background-color: rgba(0, 0, 0, 0.1) !important;
            }
          }
        `)}`}
      />
      {/* Critical CSS to prevent border flash */}
      <style dangerouslySetInnerHTML={{ __html: `
        /* Critical CSS to prevent gray border flash and shape issues on page load */
        
        /* Override CSS variables in hero section scope */
        #hero {
          --border: transparent !important;
          --input: transparent !important;
          --ring: transparent !important;
          --border-border: transparent !important;
        }
        
        /* Safari-specific variable fixes */
        @supports (-webkit-appearance: none) {
          #hero {
            --border: transparent !important;
            --input: transparent !important;
            --ring: transparent !important;
            --border-border: transparent !important;
          }
        }
        
        /* Target all hero elements by data attribute to ensure specificity */
        [data-hero-element] {
          border: 0 !important;
          border-color: transparent !important;
          outline: none !important;
        }
        
        [data-hero-element]::before,
        [data-hero-element]::after {
          border: 0 !important;
          border-color: transparent !important;
        }
        
        /* Reset all borders in hero section first */
        #hero,
        #hero *,
        #hero *::before,
        #hero *::after {
          border: 0 !important;
          border-color: transparent !important;
          outline: none !important;
        }
        
        /* Target ALL elements to prevent gray borders */
        #hero * {
          border-color: transparent !important;
        }
        
        /* Specifically target border utility classes */
        #hero .border,
        #hero .border-t,
        #hero .border-r,
        #hero .border-b,
        #hero .border-l,
        #hero .border-x,
        #hero .border-y,
        #hero .border-input,
        #hero [class*="border-"],
        #hero [class*="border "],
        #hero [class*=" border"] {
          border-color: transparent !important;
        }
        
        /* Override Input component border styles */
        #hero input,
        #hero input[type="text"],
        #hero input[type="email"],
        #hero input[type="password"] {
          border: 0 !important;
          border-color: transparent !important;
          outline: none !important;
          box-shadow: none !important;
        }
        
        /* Ensure motion divs have no borders */
        #hero div[style*="transform"],
        #hero [data-framer-component-type] {
          border: 0 !important;
          border-color: transparent !important;
        }
        
        /* Safari-specific fixes for all elements */
        @supports (-webkit-appearance: none) {
          #hero,
          #hero *,
          #hero *::before,
          #hero *::after {
            border: none !important;
            border-style: none !important;
            border-width: 0 !important;
            border-color: transparent !important;
            border-image: none !important;
            -webkit-border-before: none !important;
            -webkit-border-after: none !important;
            -webkit-border-start: none !important;
            -webkit-border-end: none !important;
            outline: none !important;
            outline-style: none !important;
            outline-width: 0 !important;
          }
          
          /* Safari input specific */
          #hero input,
          #hero .hero-input,
          #hero input[type="text"] {
            -webkit-appearance: none !important;
            border: none !important;
            border-style: none !important;
            border-width: 0 !important;
            border-color: transparent !important;
            background-clip: padding-box !important;
            -webkit-background-clip: padding-box !important;
            -webkit-tap-highlight-color: transparent !important;
          }
          
          /* Safari border class override */
          #hero [class*="border"],
          #hero .border-input {
            border: none !important;
            border-style: none !important;
            border-width: 0 !important;
            border-color: transparent !important;
          }
        }
        
        /* Motion wrapper specific styles */
        #hero .flex.items-center.w-full {
          border: none !important;
        }
        
        /* Hero input wrapper motion div */
        #hero .hero-input-wrapper {
          border: none !important;
          background: transparent !important;
          box-shadow: none !important;
        }
        
        /* Form and all its children */
        #hero-form,
        #hero-form * {
          border-color: transparent !important;
        }
        
        /* The relative wrapper div */
        #hero-form > div.relative {
          border: none !important;
          background: transparent !important;
        }
        
        /* Glow effect div */
        #hero .hero-glow-effect {
          border: none !important;
          opacity: 0 !important;
          background: transparent !important;
          box-shadow: none !important;
        }
        
        /* Loaded state for glow effect */
        #hero.loaded .hero-glow-effect {
          background: linear-gradient(to right, rgba(34, 211, 238, 0.2), rgba(34, 211, 238, 0.1), rgba(34, 211, 238, 0.2)) !important;
          opacity: 0 !important;
          transition: opacity 500ms cubic-bezier(0.4, 0, 0.2, 1) !important;
        }
        
        #hero.loaded .group:hover .hero-glow-effect,
        #hero.loaded .group:focus-within .hero-glow-effect {
          opacity: 1 !important;
        }
        
        /* Prevent border animations during load */
        #hero *,
        #hero *::before,
        #hero *::after {
          transition: none !important;
          animation: none !important;
        }
        
        /* Re-enable transitions after load */
        #hero.loaded .hero-input-container,
        #hero.loaded .hero-glow-effect,
        #hero.loaded button,
        #hero.loaded input {
          transition-property: border-color, background-color, opacity, transform, box-shadow !important;
          transition-duration: 300ms !important;
          transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1) !important;
        }
        
        /* Ensure no borders on motion divs */
        #hero [data-framer-component-type] {
          border: none !important;
        }
        
        /* Main input container */
        #hero .hero-input-container {
          border: 1px solid rgba(34, 211, 238, 0.3) !important;
          border-width: 1px !important;
          border-style: solid !important;
          border-radius: 9999px !important; /* rounded-full */
          background-color: rgba(255, 255, 255, 0.1) !important;
          backdrop-filter: blur(12px) !important;
          -webkit-backdrop-filter: blur(12px) !important;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1) !important;
          padding-left: 1.5rem !important;
          padding-right: 1.5rem !important;
          display: flex !important;
          align-items: center !important;
          position: relative !important;
          transition: all 300ms cubic-bezier(0.4, 0, 0.2, 1) !important;
          /* Prevent any size changes */
          width: 100% !important;
          height: auto !important;
          min-height: 4rem !important; /* h-16 */
          overflow: hidden !important;
        }
        
        /* Safari-specific input container fix - must come after general Safari fixes */
        @supports (-webkit-appearance: none) {
          #hero .hero-input-container {
            border: 1px solid rgba(34, 211, 238, 0.3) !important;
            border-width: 1px !important;
            border-style: solid !important;
            border-color: rgba(34, 211, 238, 0.3) !important;
            -webkit-border-before: initial !important;
            -webkit-border-after: initial !important;
            -webkit-border-start: initial !important;
            -webkit-border-end: initial !important;
          }
        }
        @media (prefers-color-scheme: dark) {
          #hero .hero-input-container {
            background-color: rgba(0, 0, 0, 0.1) !important;
          }
        }
        @media (min-width: 1024px) {
          #hero .hero-input-container {
            min-height: 4.5rem !important; /* lg:h-18 */
          }
        }
        #hero .hero-input-container:hover {
          border-color: rgba(34, 211, 238, 0.5) !important;
          background-color: rgba(255, 255, 255, 0.15) !important;
        }
        @media (prefers-color-scheme: dark) {
          #hero .hero-input-container:hover {
            background-color: rgba(0, 0, 0, 0.15) !important;
          }
        }
        #hero .hero-input-container:focus-within {
          border-color: rgba(34, 211, 238, 0.7) !important;
          background-color: rgba(255, 255, 255, 0.2) !important;
        }
        @media (prefers-color-scheme: dark) {
          #hero .hero-input-container:focus-within {
            background-color: rgba(0, 0, 0, 0.2) !important;
          }
        }
        #hero .hero-input-container * {
          border: none !important;
          outline: none !important;
        }
        #hero .hero-input-container input {
          border: 0 !important;
          outline: none !important;
          -webkit-appearance: none !important;
          -moz-appearance: none !important;
          appearance: none !important;
          background: transparent !important;
          width: 100% !important;
          flex: 1 !important;
        }
        #hero .hero-input {
          border: 0 !important;
          border-color: transparent !important;
          outline: none !important;
          box-shadow: none !important;
          -webkit-appearance: none !important;
          -moz-appearance: none !important;
          appearance: none !important;
        }
        #hero .hero-input:focus,
        #hero .hero-input:hover,
        #hero .hero-input:active {
          border: 0 !important;
          border-color: transparent !important;
          outline: none !important;
          box-shadow: none !important;
        }
        #hero .hero-input-container button {
          border-radius: 9999px !important;
        }
        /* Ensure form and glow don't affect sizing */
        #hero form {
          width: 100% !important;
          position: relative !important;
        }
        #hero form > div:first-child {
          position: relative !important;
        }
        #hero .hero-input-container + div {
          pointer-events: none !important;
        }
      `}} />

      <div className="relative flex flex-col items-center w-full px-6 z-20">
        {/* Center content */}
        <motion.div 
          className="relative z-30 max-w-4xl mx-auto h-full w-full flex flex-col gap-8 lg:gap-12 items-center justify-center -mt-16 md:-mt-20"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        >
          {/* Hero text with improved typography */}
          <motion.div 
            className="flex flex-col items-center justify-center gap-4 md:gap-6 text-center relative z-40"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.8 }}
          >
            {/* Badge with enhanced styling - moved above the main heading */}
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.1, duration: 0.6 }}
              className="relative z-50 mb-2"
            >
              <Link
                href="#enterprise"
                className="group relative inline-flex items-center gap-2 rounded-full border border-border/50 bg-background/20 backdrop-blur-sm px-4 py-2 text-sm transition-all duration-300 hover:border-border/70 hover:bg-background/30 hover:shadow-lg hover:shadow-primary/20"
              >
                <div className="flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  <GradientText 
                    text={hero.badge}
                    gradient="linear-gradient(90deg, #3b82f6 0%, #a855f7 20%, #ec4899 50%, #a855f7 80%, #3b82f6 100%)"
                    transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
                    className="font-medium text-xs tracking-wider uppercase group-hover:opacity-90 transition-opacity duration-300"
                  />
                </div>
                <div className="inline-flex items-center justify-center size-4 rounded-full bg-primary/20 group-hover:bg-primary/30 transition-colors duration-300">
                  <ArrowRight className="h-2.5 w-2.5 text-primary group-hover:translate-x-0.5 transition-transform duration-300" />
                </div>
              </Link>
            </motion.div>

            {/* Lamp Container positioned between badge and title */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3, duration: 1.2 }}
              className="relative z-10 w-full max-w-4xl mx-auto"
            >
              <div className="relative w-full h-3 md:h-4 flex items-center justify-center">
                {/* Glow effect container */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="relative w-full max-w-sm md:max-w-md h-[2px]">
                    {/* Far outer glow - very soft and wide */}
                    <motion.div
                      className="absolute inset-0 bg-[length:700%_100%] bg-[position:0%_0%] rounded-full blur-[48px] opacity-20"
                      style={{
                        backgroundImage: 'linear-gradient(90deg, #3b82f6 0%, #a855f7 20%, #ec4899 50%, #a855f7 80%, #3b82f6 100%)',
                        transform: 'scale(4, 20)',
                        transformOrigin: 'center 30%',
                      }}
                      initial={{ backgroundPosition: '0% 0%' }}
                      animate={{ backgroundPosition: '500% 100%' }}
                      transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
                    />
                    
                    {/* Extended outer glow */}
                    <motion.div
                      className="absolute inset-0 bg-[length:700%_100%] bg-[position:0%_0%] rounded-full blur-[32px] opacity-30"
                      style={{
                        backgroundImage: 'linear-gradient(90deg, #3b82f6 0%, #a855f7 20%, #ec4899 50%, #a855f7 80%, #3b82f6 100%)',
                        transform: 'scale(3, 16)',
                        transformOrigin: 'center 30%',
                      }}
                      initial={{ backgroundPosition: '0% 0%' }}
                      animate={{ backgroundPosition: '500% 100%' }}
                      transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
                    />
                    
                    {/* Medium glow */}
                    <motion.div
                      className="absolute inset-0 bg-[length:700%_100%] bg-[position:0%_0%] rounded-full blur-[20px] opacity-40"
                      style={{
                        backgroundImage: 'linear-gradient(90deg, #3b82f6 0%, #a855f7 20%, #ec4899 50%, #a855f7 80%, #3b82f6 100%)',
                        transform: 'scale(2, 10)',
                        transformOrigin: 'center 30%',
                      }}
                      initial={{ backgroundPosition: '0% 0%' }}
                      animate={{ backgroundPosition: '500% 100%' }}
                      transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
                    />
                    
                    {/* Inner medium glow */}
                    <motion.div
                      className="absolute inset-0 bg-[length:700%_100%] bg-[position:0%_0%] rounded-full blur-[12px] opacity-50"
                      style={{
                        backgroundImage: 'linear-gradient(90deg, #3b82f6 0%, #a855f7 20%, #ec4899 50%, #a855f7 80%, #3b82f6 100%)',
                        transform: 'scale(1.8, 6)',
                        transformOrigin: 'center 30%',
                      }}
                      initial={{ backgroundPosition: '0% 0%' }}
                      animate={{ backgroundPosition: '500% 100%' }}
                      transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
                    />
                    
                    {/* Inner glow */}
                    <motion.div
                      className="absolute inset-0 bg-[length:700%_100%] bg-[position:0%_0%] rounded-full blur-[6px] opacity-70 mix-blend-plus-lighter"
                      style={{
                        backgroundImage: 'linear-gradient(90deg, #3b82f6 0%, #a855f7 20%, #ec4899 50%, #a855f7 80%, #3b82f6 100%)',
                        transform: 'scale(1.5, 4)',
                        transformOrigin: 'center 30%',
                      }}
                      initial={{ backgroundPosition: '0% 0%' }}
                      animate={{ backgroundPosition: '500% 100%' }}
                      transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
                    />
                    
                    {/* Main gradient line */}
                    <motion.div
                      className="absolute inset-0 bg-[length:700%_100%] bg-[position:0%_0%] rounded-full"
                      style={{
                        backgroundImage: 'linear-gradient(90deg, #3b82f6 0%, #a855f7 20%, #ec4899 50%, #a855f7 80%, #3b82f6 100%)',
                      }}
                      initial={{ backgroundPosition: '0% 0%' }}
                      animate={{ backgroundPosition: '500% 100%' }}
                      transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
                    />
                  </div>
                </div>
              </div>
            </motion.div>
            
            <motion.h1 
              className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl xl:text-7xl font-semibold tracking-tight text-balance leading-[1.1] bg-gradient-to-br from-foreground to-foreground/80 bg-clip-text text-transparent drop-shadow-lg px-4 relative z-40"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5, duration: 0.8 }}
            >
              {hero.title}
            </motion.h1>
            
            <motion.p 
              className="text-base sm:text-lg md:text-xl lg:text-2xl text-center text-muted-foreground font-normal text-balance leading-relaxed max-w-2xl tracking-tight drop-shadow-md px-4 relative z-40"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.7, duration: 0.8 }}
            >
              a generalist{' '}
              <GradientText 
                text="AI Agent" 
                gradient="linear-gradient(90deg, #3b82f6 0%, #a855f7 20%, #ec4899 50%, #a855f7 80%, #3b82f6 100%)"
                transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
              />{' '}
              that works on your behalf.
            </motion.p>
          </motion.div>

          {/* Enhanced input with modern styling */}
          <motion.div 
            className="hero-input-wrapper flex items-center w-full max-w-2xl relative z-40"
            data-hero-element="wrapper"
            style={{
              border: '0',
              borderColor: 'transparent',
              outline: 'none'
            }}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.9, duration: 0.8 }}
            layout="position"
          >
            <form 
              className="w-full relative group" 
              onSubmit={handleSubmit}
              id="hero-form"
              data-hero-element="form"
              data-safari-fix="form"
              style={{
                border: 'none',
                borderStyle: 'none',
                borderWidth: '0',
                borderColor: 'transparent',
                outline: 'none'
              }}
            >
              <div 
                className="relative" 
                data-hero-element="container" 
                data-safari-fix="container"
                style={{ 
                  border: 'none',
                  borderStyle: 'none',
                  borderWidth: '0',
                  borderColor: 'transparent',
                  outline: 'none'
                }}
              >
                {/* Enhanced glow effect */}
                <div 
                  className="hero-glow-effect absolute -inset-1 bg-gradient-to-r from-cyan-500/20 via-cyan-400/10 to-cyan-500/20 rounded-full blur-lg opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all duration-500 pointer-events-none" 
                  data-hero-element="glow"
                  style={{ border: '0', borderColor: 'transparent', outline: 'none' }}
                ></div>
                
                {/* Input container with beautiful theme-aware design */}
                <div 
                  className="hero-input-container relative flex items-center rounded-full px-4 sm:px-6 transition-all duration-300"
                  data-hero-element="input-container"
                  data-safari-fix="true"
                  style={{
                    border: '1px solid rgba(34, 211, 238, 0.3)',
                    borderRadius: '9999px',
                    backgroundColor: 'rgba(255, 255, 255, 0.1)',
                    backdropFilter: 'blur(12px)',
                    WebkitBackdropFilter: 'blur(12px)',
                    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1)',
                    paddingLeft: '1rem',
                    paddingRight: '1rem',
                    display: 'flex',
                    alignItems: 'center',
                    position: 'relative',
                    width: '100%',
                    minHeight: '3.5rem',
                    overflow: 'hidden'
                  }}
                >
                  <input
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={hero.inputPlaceholder}
                    className="hero-input flex-1 h-14 sm:h-16 lg:h-18 rounded-full px-2 bg-transparent text-sm sm:text-base lg:text-lg text-foreground placeholder:text-muted-foreground placeholder:opacity-70 focus:placeholder:opacity-40 py-2 font-medium transition-all duration-200 appearance-none"
                    style={{
                      border: 'none',
                      borderStyle: 'none',
                      borderWidth: '0',
                      borderColor: 'transparent',
                      borderImage: 'none',
                      outline: 'none',
                      outlineStyle: 'none',
                      outlineWidth: '0',
                      boxShadow: 'none',
                      background: 'transparent',
                      backgroundColor: 'transparent',
                      WebkitAppearance: 'none',
                      MozAppearance: 'none',
                      WebkitTapHighlightColor: 'transparent',
                      ...{
                        ['-webkit-border-before' as any]: 'none',
                        ['-webkit-border-after' as any]: 'none',
                        ['-webkit-border-start' as any]: 'none',
                        ['-webkit-border-end' as any]: 'none',
                      }
                    }}
                    disabled={isSubmitting}
                    autoComplete="off"
                    spellCheck="false"
                  />
                  <motion.button
                    type="submit"
                    className={`rounded-full p-2.5 sm:p-3 lg:p-4 transition-all duration-300 ${
                      inputValue.trim()
                        ? 'bg-cyan-500 text-white hover:bg-cyan-400 shadow-lg hover:shadow-cyan-500/40 scale-100'
                        : 'bg-muted/40 text-muted-foreground scale-95'
                    }`}
                    disabled={!inputValue.trim() || isSubmitting}
                    aria-label="Submit"
                    whileHover={inputValue.trim() ? { scale: 1.05 } : {}}
                    whileTap={inputValue.trim() ? { scale: 0.95 } : {}}
                  >
                    {isSubmitting ? (
                      <div className="h-4 sm:h-5 lg:h-6 w-4 sm:w-5 lg:w-6 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <ArrowRight className="size-4 sm:size-5 lg:size-6" />
                    )}
                  </motion.button>
                </div>
              </div>
            </form>
          </motion.div>

          {/* Dynamic value proposition with FlipWords */}
          <motion.div 
            className="text-base sm:text-lg md:text-xl lg:text-2xl xl:text-3xl text-muted-foreground font-medium text-center max-w-4xl relative z-40 px-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.8, duration: 0.8 }}
          >
            {/* Mobile: Stacked layout */}
            <div className="flex flex-col gap-3 sm:hidden">
              <div className="flex items-center justify-center gap-2">
                <span className="drop-shadow-md">80% more</span>
                <FlipWords 
                  words={moreWords} 
                  duration={3000}
                  className="text-primary font-bold text-base drop-shadow-lg"
                />
              </div>
              <div className="flex items-center justify-center gap-2">
                <span className="drop-shadow-md">with 20% the</span>
                <FlipWords 
                  words={lessWords} 
                  duration={4500}
                  className="text-primary font-bold text-base drop-shadow-lg"
                />
              </div>
            </div>

            {/* Desktop: Inline layout */}
            <div className="hidden sm:flex items-center justify-center flex-wrap gap-2">
              <span className="drop-shadow-md">80% more</span>
              <FlipWords 
                words={moreWords} 
                duration={3000}
                className="text-primary font-bold drop-shadow-lg"
              />
              <span className="drop-shadow-md">with 20% the</span>
              <FlipWords 
                words={lessWords} 
                duration={4500}
                className="text-primary font-bold drop-shadow-lg"
              />
            </div>
          </motion.div>
        </motion.div>

        {/* Video section positioned below the main content with better mobile spacing */}
        <motion.div 
          className="w-full max-w-6xl mx-auto mt-8 md:mt-12 lg:mt-16 mb-8 md:mb-16 relative z-30"
          style={{ display: 'none' }} // Temporarily hide the video section
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1, duration: 1 }}
        >
          <HeroVideoSection />
        </motion.div>
      </div>

      {/* Auth Dialog with enhanced styling */}
      <Dialog open={authDialogOpen} onOpenChange={setAuthDialogOpen}>
        <BlurredDialogOverlay />
        <DialogContent className="sm:max-w-md rounded-2xl bg-background/95 dark:bg-background/95 backdrop-blur-xl border border-border/50 shadow-2xl">
          <DialogHeader className="space-y-4">
            <div className="flex items-center justify-between">
              <DialogTitle className="text-2xl font-semibold tracking-tight">
                Sign in to continue
              </DialogTitle>
            </div>
            <DialogDescription className="text-muted-foreground text-base">
              Sign in or create an account to start using Operator
            </DialogDescription>
          </DialogHeader>

          {/* Auth error message */}
          {authError && (
            <div className="mb-4 p-4 rounded-xl flex items-center gap-3 bg-destructive/10 border border-destructive/20 text-destructive">
              <AlertCircle className="h-5 w-5 flex-shrink-0" />
              <span className="text-sm font-medium">{authError}</span>
            </div>
          )}

          {/* Social Sign In Options */}
          <div className="w-full space-y-3">
            <GoogleSignIn returnUrl="/dashboard" />
            <MicrosoftSignIn returnUrl="/dashboard" />
          </div>

          {/* Divider */}
          <div className="relative my-8">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border/50"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-4 bg-background text-muted-foreground font-medium">
                or continue with email
              </span>
            </div>
          </div>

          {/* Sign in form with enhanced styling */}
          <form className="space-y-4">
            <div>
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="Enter your email"
                className="h-12 rounded-xl bg-background/50 border-border/50 focus:border-secondary/50 transition-colors"
                required
              />
            </div>

            <div>
              <Input
                id="password"
                name="password"
                type="password"
                placeholder="Enter your password"
                className="h-12 rounded-xl bg-background/50 border-border/50 focus:border-secondary/50 transition-colors"
                required
              />
            </div>

            <div className="space-y-4 pt-4">
              <SubmitButton
                formAction={handleSignIn}
                className="w-full h-12 rounded-xl bg-secondary text-secondary-foreground hover:bg-secondary/90 transition-all shadow-lg hover:shadow-secondary/25"
                pendingText="Signing in..."
              >
                Sign in
              </SubmitButton>

              <Link
                href={`/auth?mode=signup&returnUrl=${encodeURIComponent('/dashboard')}`}
                className="flex h-12 items-center justify-center w-full text-center rounded-xl border border-border/50 bg-background/50 hover:bg-secondary/5 hover:border-secondary/30 transition-all"
                onClick={() => setAuthDialogOpen(false)}
              >
                Create new account
              </Link>
            </div>

            <div className="text-center pt-4">
              <Link
                href={`/auth?returnUrl=${encodeURIComponent('/dashboard')}`}
                className="text-sm text-secondary hover:text-secondary/80 font-medium transition-colors"
                onClick={() => setAuthDialogOpen(false)}
              >
                More sign in options
              </Link>
            </div>
          </form>

          <div className="mt-6 text-center text-xs text-muted-foreground/80">
            By continuing, you agree to our{' '}
            <Link href="/terms" className="text-secondary hover:text-secondary/80 font-medium">
              Terms of Service
            </Link>{' '}
            and{' '}
            <Link href="/privacy" className="text-secondary hover:text-secondary/80 font-medium">
              Privacy Policy
            </Link>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Billing Error Alert here */}
      <BillingErrorAlert
        message={billingError?.message}
        currentUsage={billingError?.currentUsage}
        limit={billingError?.limit}
        accountId={personalAccount?.account_id}
        onDismiss={clearBillingError}
        isOpen={!!billingError}
      />
    </section>
  );
}
