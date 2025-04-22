"use client"
import { HeroVideoSection } from "@/components/home/sections/hero-video-section";
import { siteConfig } from "@/lib/home";
import { ArrowRight, Github, X, AlertCircle } from "lucide-react";
import { FlickeringGrid } from "@/components/home/ui/flickering-grid";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useState, useEffect, useRef, FormEvent } from "react";
import { useScroll } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { createProject, createThread, addUserMessage, startAgent } from "@/lib/api";
import { generateThreadName } from "@/lib/actions/threads";
import GoogleSignIn from "@/components/GoogleSignIn";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { 
  Dialog, 
  DialogContent, 
  DialogDescription, 
  DialogHeader, 
  DialogTitle,
  DialogOverlay
} from "@/components/ui/dialog";

// Custom dialog overlay with blur effect
const BlurredDialogOverlay = () => (
  <DialogOverlay className="bg-background/40 backdrop-blur-md" />
);

// Constant for localStorage key to ensure consistency
const PENDING_PROMPT_KEY = 'pendingAgentPrompt';

export function HeroSection() {
  const { hero } = siteConfig;
  const tablet = useMediaQuery("(max-width: 1024px)");
  const [mounted, setMounted] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const scrollTimeout = useRef<NodeJS.Timeout | null>(null);
  const { scrollY } = useScroll();
  const [inputValue, setInputValue] = useState("");
  const router = useRouter();
  const { user, isLoading } = useAuth();
  
  // Auth dialog state
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Detect when scrolling is active to reduce animation complexity
  useEffect(() => {
    const unsubscribe = scrollY.on("change", () => {
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

  // Store the input value when auth dialog opens
  useEffect(() => {
    if (authDialogOpen && inputValue.trim()) {
      localStorage.setItem(PENDING_PROMPT_KEY, inputValue.trim());
    }
  }, [authDialogOpen, inputValue]);
  
  // Close dialog and redirect when user authenticates
  useEffect(() => {
    if (authDialogOpen && user && !isLoading) {
      setAuthDialogOpen(false);
      router.push('/dashboard');
    }
  }, [user, isLoading, authDialogOpen, router]);

  // Create an agent with the provided prompt
  const createAgentWithPrompt = async () => {
    if (!inputValue.trim() || isSubmitting) return;
    
    setIsSubmitting(true);
    
    try {
      // Generate a name for the project using GPT
      const projectName = await generateThreadName(inputValue);
      
      // 1. Create a new project with the GPT-generated name
      const newAgent = await createProject({
        name: projectName,
        description: "",
      });
      
      // 2. Create a new thread for this project
      const thread = await createThread(newAgent.id);
      
      // 3. Add the user message to the thread
      await addUserMessage(thread.thread_id, inputValue.trim());
      
      // 4. Start the agent with the thread ID
      await startAgent(thread.thread_id, {
        stream: true
      });
      
      // 5. Navigate to the new agent's thread page
      router.push(`/agents/${thread.thread_id}`);
    } catch (error) {
      console.error("Error creating agent:", error);
      setIsSubmitting(false);
    }
  };

  // Handle form submission
  const handleSubmit = async (e?: FormEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation(); // Stop event propagation to prevent dialog closing
    }
    
    if (!inputValue.trim() || isSubmitting) return;
    
    // If user is not logged in, save prompt and show auth dialog
    if (!user && !isLoading) {
      // Save prompt to localStorage BEFORE showing the dialog
      localStorage.setItem(PENDING_PROMPT_KEY, inputValue.trim());
      setAuthDialogOpen(true);
      return;
    }
    
    // User is logged in, create the agent
    createAgentWithPrompt();
  };
  
  // Handle Enter key press
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault(); // Prevent default form submission
      e.stopPropagation(); // Stop event propagation
      handleSubmit();
    }
  };
  
  // Handle auth form submission
  const handleSignIn = async (prevState: any, formData: FormData) => {
    setAuthError(null);
    try {
      // Implement sign in logic here
      const email = formData.get("email") as string;
      const password = formData.get("password") as string;
      
      // Add the returnUrl to the form data for proper redirection
      formData.append("returnUrl", "/dashboard");
      
      // Call your authentication function here
      
      // Return any error state
      return { message: "Invalid credentials" };
    } catch (error) {
      console.error("Sign in error:", error);
      setAuthError(error instanceof Error ? error.message : "An error occurred");
      return { message: "An error occurred during sign in" };
    }
  };

  return (
    <section id="hero" className="w-full relative overflow-hidden">
      <div className="relative flex flex-col items-center w-full px-6">
        {/* Left side flickering grid with gradient fades */}
        <div className="absolute left-0 top-0 h-[600px] md:h-[800px] w-1/3 -z-10 overflow-hidden">
          {/* Horizontal fade from left to right */}
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-background z-10" />
          
          {/* Vertical fade from top */}
          <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-background via-background/90 to-transparent z-10" />
          
          {/* Vertical fade to bottom */}
          <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-background via-background/90 to-transparent z-10" />
          
          <FlickeringGrid
            className="h-full w-full"
            squareSize={mounted && tablet ? 2 : 2.5}
            gridGap={mounted && tablet ? 2 : 2.5}
            color="var(--secondary)"
            maxOpacity={0.4}
            flickerChance={isScrolling ? 0.01 : 0.03} // Low flickering when not scrolling
          />
        </div>
        
        {/* Right side flickering grid with gradient fades */}
        <div className="absolute right-0 top-0 h-[600px] md:h-[800px] w-1/3 -z-10 overflow-hidden">
          {/* Horizontal fade from right to left */}
          <div className="absolute inset-0 bg-gradient-to-l from-transparent via-transparent to-background z-10" />
          
          {/* Vertical fade from top */}
          <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-background via-background/90 to-transparent z-10" />
          
          {/* Vertical fade to bottom */}
          <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-background via-background/90 to-transparent z-10" />
          
          <FlickeringGrid
            className="h-full w-full"
            squareSize={mounted && tablet ? 2 : 2.5}
            gridGap={mounted && tablet ? 2 : 2.5}
            color="var(--secondary)"
            maxOpacity={0.4}
            flickerChance={isScrolling ? 0.01 : 0.03} // Low flickering when not scrolling
          />
        </div>
        
        {/* Center content background with rounded bottom */}
        <div className="absolute inset-x-1/4 top-0 h-[600px] md:h-[800px] -z-20 bg-background rounded-b-xl"></div>
        
        <div className="relative z-10 pt-32 max-w-3xl mx-auto h-full w-full flex flex-col gap-10 items-center justify-center">
                    {/* <p className="border border-border bg-accent rounded-full text-sm h-8 px-3 flex items-center gap-2">
            {hero.badgeIcon}
            {hero.badge}
          </p> */}

          <Link 
            href={hero.githubUrl} 
            target="_blank" 
            rel="noopener noreferrer"
            className="group border border-border/50 bg-background hover:bg-accent/20 hover:border-secondary/40 rounded-full text-sm h-8 px-3 flex items-center gap-2 transition-all duration-300 shadow-sm hover:shadow-md hover:scale-105 hover:-translate-y-0.5"
          >
            {hero.badgeIcon}
            <span className="font-medium text-muted-foreground text-xs tracking-wide group-hover:text-primary transition-colors duration-300">{hero.badge}</span>
            <span className="inline-flex items-center justify-center size-3.5 rounded-full bg-muted/30 group-hover:bg-secondary/30 transition-colors duration-300">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-muted-foreground group-hover:text-primary">
                <path d="M7 17L17 7M17 7H8M17 7V16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </span>
          </Link>
          <div className="flex flex-col items-center justify-center gap-5">
            <h1 className="text-3xl md:text-4xl lg:text-5xl xl:text-6xl font-medium tracking-tighter text-balance text-center">
              <span className="text-secondary">Suna</span><span className="text-primary">, your AI Employee.</span>
            </h1>
            <p className="text-base md:text-lg text-center text-muted-foreground font-medium text-balance leading-relaxed tracking-tight">
              {hero.description}
            </p>
          </div>
          <div className="flex items-center w-full max-w-xl gap-2 flex-wrap justify-center">
            <form className="w-full relative" onSubmit={handleSubmit}>
              {/* ChatGPT-like input with glow effect */}
              <div className="relative z-10">
                <div className="flex items-center rounded-full border border-border bg-background/80 backdrop-blur px-4 shadow-lg transition-all duration-200 hover:border-secondary/50 focus-within:border-secondary/50 focus-within:shadow-[0_0_15px_rgba(var(--secondary),0.3)]">
                  <input
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={hero.inputPlaceholder}
                    className="flex-1 h-12 md:h-14 rounded-full px-2 bg-transparent focus:outline-none text-sm md:text-base py-2"
                    disabled={isSubmitting}
                  />
                  <button 
                    type="submit"
                    className={`rounded-full p-2 md:p-3 transition-all duration-200 ${
                      inputValue.trim() 
                        ? "bg-secondary text-secondary-foreground hover:bg-secondary/80" 
                        : "bg-muted text-muted-foreground"
                    }`}
                    disabled={!inputValue.trim() || isSubmitting}
                    aria-label="Submit"
                  >
                    {isSubmitting ? (
                      <div className="h-4 md:h-5 w-4 md:w-5 border-2 border-secondary-foreground border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <ArrowRight className="size-4 md:size-5" />
                    )}
                  </button>
                </div>
              </div>
              {/* Subtle glow effect */}
              <div className="absolute -bottom-4 inset-x-0 h-6 bg-secondary/20 blur-xl rounded-full -z-10 opacity-70"></div>
            </form>
          </div>
        </div>
      </div>
      <div className="mb-10 max-w-4xl mx-auto">
        <HeroVideoSection />
      </div>

      {/* Auth Dialog */}
      <Dialog open={authDialogOpen} onOpenChange={setAuthDialogOpen}>
        <BlurredDialogOverlay />
        <DialogContent className="sm:max-w-md rounded-xl bg-[#F3F4F6] dark:bg-[#F9FAFB]/[0.02] border border-border">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle className="text-xl font-medium">Sign in to continue</DialogTitle>
              {/* <button 
                onClick={() => setAuthDialogOpen(false)}
                className="rounded-full p-1 hover:bg-muted transition-colors"
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </button> */}
            </div>
            <DialogDescription className="text-muted-foreground">
              Sign in or create an account to talk with Suna
            </DialogDescription>
          </DialogHeader>
          
          {/* Auth error message */}
          {authError && (
            <div className="mb-4 p-3 rounded-lg flex items-center gap-3 bg-secondary/10 border border-secondary/20 text-secondary">
              <AlertCircle className="h-5 w-5 flex-shrink-0 text-secondary" />
              <span className="text-sm font-medium">{authError}</span>
            </div>
          )}
          
          {/* Google Sign In */}
          <div className="w-full">
            <GoogleSignIn returnUrl="/dashboard" />
          </div>

          {/* Divider */}
          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-[#F3F4F6] dark:bg-[#F9FAFB]/[0.02] text-muted-foreground">
                or continue with email
              </span>
            </div>
          </div>

          {/* Sign in form */}
          <form className="space-y-4">
            <div>
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="Email address"
                className="h-12 rounded-full bg-background border-border"
                required
              />
            </div>
            
            <div>
              <Input
                id="password"
                name="password"
                type="password"
                placeholder="Password"
                className="h-12 rounded-full bg-background border-border"
                required
              />
            </div>
            
            <div className="space-y-4 pt-4">
              <SubmitButton
                formAction={handleSignIn}
                className="w-full h-12 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-all shadow-md"
                pendingText="Signing in..."
              >
                Sign in
              </SubmitButton>
              
              <Link
                href={`/auth?mode=signup&returnUrl=${encodeURIComponent("/dashboard")}`}
                className="flex h-12 items-center justify-center w-full text-center rounded-full border border-border bg-background hover:bg-accent/20 transition-all"
                onClick={() => setAuthDialogOpen(false)}
              >
                Create new account
              </Link>
            </div>

            <div className="text-center pt-2">
              <Link 
                href={`/auth?returnUrl=${encodeURIComponent("/dashboard")}`}
                className="text-sm text-primary hover:underline"
                onClick={() => setAuthDialogOpen(false)}
              >
                More sign in options
              </Link>
            </div>
          </form>

          <div className="mt-4 text-center text-xs text-muted-foreground">
            By continuing, you agree to our{' '}
            <Link href="/terms" className="text-primary hover:underline">
              Terms of Service
            </Link>{' '}
            and{' '}<Link href="/privacy" className="text-primary hover:underline">Privacy Policy</Link>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}