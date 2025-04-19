"use client";

import { SectionHeader } from "@/components/home/section-header";
import { siteConfig } from "@/lib/home";
import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import { useState } from "react";
import { Github, GitFork, File, Terminal } from "lucide-react";
import Link from "next/link";

interface TabsProps {
  activeTab: "cloud" | "self-hosted";
  setActiveTab: (tab: "cloud" | "self-hosted") => void;
  className?: string;
}

function PricingTabs({ activeTab, setActiveTab, className }: TabsProps) {
  return (
    <div
      className={cn(
        "relative flex w-fit items-center rounded-full border p-0.5 backdrop-blur-sm cursor-pointer h-9 flex-row bg-muted",
        className,
      )}
    >
      {["cloud", "self-hosted"].map((tab) => (
        <button
          key={tab}
          onClick={() => setActiveTab(tab as "cloud" | "self-hosted")}
          className={cn(
            "relative z-[1] px-3 h-8 flex items-center justify-center cursor-pointer",
            {
              "z-0": activeTab === tab,
            },
          )}
        >
          {activeTab === tab && (
            <motion.div
              layoutId="active-tab"
              className="absolute inset-0 rounded-full bg-white dark:bg-[#3F3F46] shadow-md border border-border"
              transition={{
                duration: 0.2,
                type: "spring",
                stiffness: 300,
                damping: 25,
                velocity: 2,
              }}
            />
          )}
          <span
            className={cn(
              "relative block text-sm font-medium duration-200 shrink-0",
              activeTab === tab ? "text-primary" : "text-muted-foreground",
            )}
          >
            {tab === "cloud" ? "Cloud" : "Self-hosted"}
          </span>
        </button>
      ))}
    </div>
  );
}

export function PricingSection() {
  const [deploymentType, setDeploymentType] = useState<"cloud" | "self-hosted">(
    "cloud",
  );

  // Handle tab change
  const handleTabChange = (tab: "cloud" | "self-hosted") => {
    if (tab === "self-hosted") {
      // Scroll to the open-source section when self-hosted tab is clicked
      const openSourceSection = document.getElementById("open-source");
      if (openSourceSection) {
        // Get the position of the section and scroll to a position slightly above it
        const rect = openSourceSection.getBoundingClientRect();
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const offsetPosition = scrollTop + rect.top - 100; // 100px offset from the top
        
        window.scrollTo({
          top: offsetPosition,
          behavior: 'smooth'
        });
      }
    } else {
      // Set the deployment type to cloud for cloud tab
      setDeploymentType(tab);
    }
  };

  // Update price animation
  const PriceDisplay = ({
    tier,
  }: {
    tier: typeof siteConfig.cloudPricingItems[0];
  }) => {
    const price = tier.price;

    return (
      <motion.span
        key={price}
        className="text-4xl font-semibold"
        initial={{
          opacity: 0,
          x: 10,
          filter: "blur(5px)",
        }}
        animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
      >
        {price}
      </motion.span>
    );
  };

  const SelfHostedContent = () => (
    <div className="rounded-xl bg-[#F3F4F6] dark:bg-[#F9FAFB]/[0.02] border border-border p-8 w-full max-w-6xl mx-auto">
      <div className="flex flex-col gap-6">
        <div className="inline-flex h-10 w-fit items-center justify-center gap-2 rounded-full bg-secondary/10 text-secondary px-4">
          <Github className="h-5 w-5" />
          <span className="text-sm font-medium">100% Open Source</span>
        </div>
        
        <div className="space-y-2">
          <h3 className="text-2xl font-semibold tracking-tight">
            Self-Hosted Version
          </h3>
          <p className="text-muted-foreground">
            Set up and run the platform on your own infrastructure with complete control over your data and deployment.
          </p>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-6">
          <div className="rounded-xl border border-border bg-background p-6 flex flex-col gap-4">
            <div className="size-10 flex items-center justify-center rounded-full bg-primary/10 text-primary">
              <GitFork className="h-5 w-5" />
            </div>
            <h4 className="text-lg font-medium">Fork & Setup</h4>
            <p className="text-sm text-muted-foreground">
              Fork the repository and follow our step-by-step setup guide to deploy on your own infrastructure.
            </p>
            <Link 
              href="https://github.com/Kortix-ai/Suna" 
              target="_blank"
              className="text-sm text-primary flex items-center gap-1 mt-auto"
            >
              Fork on GitHub
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M7 17L17 7M17 7H8M17 7V16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </Link>
          </div>
          
          <div className="rounded-xl border border-border bg-background p-6 flex flex-col gap-4">
            <div className="size-10 flex items-center justify-center rounded-full bg-primary/10 text-primary">
              <File className="h-5 w-5" />
            </div>
            <h4 className="text-lg font-medium">Documentation</h4>
            <p className="text-sm text-muted-foreground">
              Comprehensive documentation with detailed instructions for installation, configuration, and customization.
            </p>
            <Link 
              href="#" 
              className="text-sm text-primary flex items-center gap-1 mt-auto"
            >
              Read the docs
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M7 17L17 7M17 7H8M17 7V16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </Link>
          </div>
          
          <div className="rounded-xl border border-border bg-background p-6 flex flex-col gap-4">
            <div className="size-10 flex items-center justify-center rounded-full bg-primary/10 text-primary">
              <Terminal className="h-5 w-5" />
            </div>
            <h4 className="text-lg font-medium">Custom APIs</h4>
            <p className="text-sm text-muted-foreground">
              Connect to your preferred language models and customize the platform to fit your specific requirements.
            </p>
            <Link 
              href="#" 
              className="text-sm text-primary flex items-center gap-1 mt-auto"
            >
              API Reference
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M7 17L17 7M17 7H8M17 7V16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </Link>
          </div>
        </div>
        
        <div className="border-t border-border pt-6 mt-4">
          <h4 className="font-medium mb-4">Key benefits of self-hosting</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ul className="space-y-3">
              {["Complete data privacy", "Full control over infrastructure", "Custom model integration", "Unlimited usage"].map((feature) => (
                <li key={feature} className="flex items-center gap-2">
                  <div className="size-5 rounded-full border border-primary/20 flex items-center justify-center bg-muted-foreground/10">
                    <div className="size-3 flex items-center justify-center">
                      <svg width="8" height="7" viewBox="0 0 8 7" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M1.5 3.48828L3.375 5.36328L6.5 0.988281" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  </div>
                  <span className="text-sm">{feature}</span>
                </li>
              ))}
            </ul>
            <ul className="space-y-3">
              {["No usage fees", "Apache 2.0 license", "Community support", "Security customization"].map((feature) => (
                <li key={feature} className="flex items-center gap-2">
                  <div className="size-5 rounded-full border border-primary/20 flex items-center justify-center bg-muted-foreground/10">
                    <div className="size-3 flex items-center justify-center">
                      <svg width="8" height="7" viewBox="0 0 8 7" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M1.5 3.48828L3.375 5.36328L6.5 0.988281" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  </div>
                  <span className="text-sm">{feature}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        
        <div className="flex flex-col sm:flex-row gap-4 mt-4">
          <Link 
            href="https://github.com/Kortix-ai/Suna" 
            target="_blank" 
            className="inline-flex h-11 items-center justify-center gap-2 text-sm font-medium tracking-wide rounded-full bg-primary text-white px-6 shadow-md hover:bg-primary/90 transition-all"
          >
            <Github className="h-4 w-4" />
            View on GitHub
          </Link>
          <Link 
            href="#"
            className="inline-flex h-11 items-center justify-center gap-2 text-sm font-medium tracking-wide rounded-full bg-secondary/10 text-secondary px-6 border border-secondary/20 hover:bg-secondary/20 transition-all"
          >
            Read Documentation
          </Link>
        </div>
      </div>
    </div>
  );

  return (
    <section
      id="pricing"
      className="flex flex-col items-center justify-center gap-10 pb-20 w-full relative"
    >
      <SectionHeader>
        <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance">
          General Intelligence available today
        </h2>
        <p className="text-muted-foreground text-center text-balance font-medium">
          You can self-host Suna or use our cloud for managed service.
        </p>
      </SectionHeader>
      <div className="relative w-full h-full">
        <div className="absolute -top-14 left-1/2 -translate-x-1/2">
          <PricingTabs
            activeTab={deploymentType}
            setActiveTab={handleTabChange}
            className="mx-auto"
          />
        </div>

        {deploymentType === "cloud" && (
          <div className="grid min-[650px]:grid-cols-2 min-[900px]:grid-cols-3 gap-4 w-full max-w-6xl mx-auto px-6">
            {siteConfig.cloudPricingItems.map((tier) => (
              <div
                key={tier.name}
                className={cn(
                  "rounded-xl grid grid-rows-[180px_auto_1fr] relative h-fit min-[650px]:h-full min-[900px]:h-fit",
                  tier.isPopular
                    ? "md:shadow-[0px_61px_24px_-10px_rgba(0,0,0,0.01),0px_34px_20px_-8px_rgba(0,0,0,0.05),0px_15px_15px_-6px_rgba(0,0,0,0.09),0px_4px_8px_-2px_rgba(0,0,0,0.10),0px_0px_0px_1px_rgba(0,0,0,0.08)] bg-accent"
                    : "bg-[#F3F4F6] dark:bg-[#F9FAFB]/[0.02] border border-border",
                )}
              >
                <div className="flex flex-col gap-4 p-4">
                  <p className="text-sm flex items-center">
                    {tier.name}
                    {tier.isPopular && (
                      <span className="bg-gradient-to-b from-secondary/50 from-[1.92%] to-secondary to-[100%] text-white h-6 inline-flex w-fit items-center justify-center px-2 rounded-full text-sm ml-2 shadow-[0px_6px_6px_-3px_rgba(0,0,0,0.08),0px_3px_3px_-1.5px_rgba(0,0,0,0.08),0px_1px_1px_-0.5px_rgba(0,0,0,0.08),0px_0px_0px_1px_rgba(255,255,255,0.12)_inset,0px_1px_0px_0px_rgba(255,255,255,0.12)_inset]">
                      Popular
                    </span>
                  )}
                  </p>
                  <div className="flex items-baseline mt-2">
                    <PriceDisplay tier={tier} />
                    <span className="ml-2">
                      {tier.price !== "$0" ? "/month" : ""}
                    </span>
                  </div>
                  <p className="text-sm mt-2">{tier.description}</p>
                  <div className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold bg-primary/10 border-primary/20 text-primary w-fit">
                    {tier.hours}/month
                  </div>
                </div>

                <div className="flex flex-col gap-2 p-4">
                  <button
                    className={`h-10 w-full flex items-center justify-center text-sm font-normal tracking-wide rounded-full px-4 cursor-pointer transition-all ease-out active:scale-95 ${
                      tier.isPopular
                        ? `${tier.buttonColor} shadow-[inset_0_1px_2px_rgba(255,255,255,0.25),0_3px_3px_-1.5px_rgba(16,24,40,0.06),0_1px_1px_rgba(16,24,40,0.08)]`
                        : `${tier.buttonColor} shadow-[0px_1px_2px_0px_rgba(255,255,255,0.16)_inset,0px_3px_3px_-1.5px_rgba(16,24,40,0.24),0px_1px_1px_-0.5px_rgba(16,24,40,0.20)]`
                    }`}
                  >
                    {tier.buttonText}
                  </button>
                </div>
                <hr className="border-border dark:border-white/20" />
                <div className="p-4">
                  {tier.name !== "Free" && (
                    <p className="text-sm mb-4">
                      Everything in {tier.name === "Pro" ? "Free" : "Pro"} +
                    </p>
                  )}
                  <ul className="space-y-3">
                    {tier.features.map((feature) => (
                      <li key={feature} className="flex items-center gap-2">
                        <div
                          className={cn(
                            "size-5 rounded-full border border-primary/20 flex items-center justify-center",
                            tier.isPopular &&
                              "bg-muted-foreground/40 border-border",
                          )}
                        >
                          <div className="size-3 flex items-center justify-center">
                            <svg
                              width="8"
                              height="7"
                              viewBox="0 0 8 7"
                              fill="none"
                              xmlns="http://www.w3.org/2000/svg"
                              className="block dark:hidden"
                            >
                              <path
                                d="M1.5 3.48828L3.375 5.36328L6.5 0.988281"
                                stroke="#101828"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>

                            <svg
                              width="8"
                              height="7"
                              viewBox="0 0 8 7"
                              fill="none"
                              xmlns="http://www.w3.org/2000/svg"
                              className="hidden dark:block"
                            >
                              <path
                                d="M1.5 3.48828L3.375 5.36328L6.5 0.988281"
                                stroke="#FAFAFA"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </div>
                        </div>
                        <span className="text-sm">{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
