"use client";

import { SectionHeader } from "@/components/home/section-header";
import { siteConfig } from "@/lib/home";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

interface Category {
  id: string;
  name: string;
}

interface UseCase {
  id: string;
  title: string;
  description: string;
  category: string;
  featured: boolean;
  icon: React.ReactNode;
  image: string;
}

function UseCasesTabs({
  categories,
  activeCategory,
  setActiveCategory,
}: {
  categories: Category[];
  activeCategory: string;
  setActiveCategory: (category: string) => void;
}) {
  return (
    <div
      className="relative flex w-fit items-center rounded-full border p-0.5 backdrop-blur-sm cursor-pointer h-9 flex-row bg-muted"
    >
      {categories.map((category) => (
        <button
          key={category.id}
          onClick={() => setActiveCategory(category.id)}
          className={cn(
            "relative z-[1] px-3 h-8 flex items-center justify-center cursor-pointer",
            {
              "z-0": activeCategory === category.id,
            },
          )}
        >
          {activeCategory === category.id && (
            <motion.div
              layoutId="active-tab-usecases"
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
              activeCategory === category.id ? "text-primary" : "text-muted-foreground",
            )}
          >
            {category.name}
          </span>
        </button>
      ))}
    </div>
  );
}

export function UseCasesSection() {
  const [activeCategory, setActiveCategory] = useState<string>("featured");
  
  // Categories for filtering - Using subset to match UI space constraints
  const categories: Category[] = [
    { id: "featured", name: "Featured" },
    { id: "research", name: "Research" },
    { id: "life", name: "Life" },
    { id: "data", name: "Data Analysis" },
  ];

  // Get use cases from siteConfig
  const useCases: UseCase[] = siteConfig.useCases || [];
  
  // Filter use cases based on active category
  const filteredUseCases = activeCategory === "featured" 
    ? useCases.filter((useCase: UseCase) => useCase.featured)
    : useCases.filter((useCase: UseCase) => useCase.category === activeCategory);

  return (
    <section
      id="use-cases"
      className="flex flex-col items-center justify-center gap-10 pb-10 w-full relative"
    >
      <SectionHeader>
        <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance">
          Use case gallery
        </h2>
        <p className="text-muted-foreground text-center text-balance font-medium">
          Learn how Suna handles real-world tasks through step-by-step replays.
        </p>
      </SectionHeader>

      <div className="relative w-full h-full">
        <div className="absolute -top-14 left-1/2 -translate-x-1/2">
          <UseCasesTabs
            categories={categories}
            activeCategory={activeCategory}
            setActiveCategory={setActiveCategory}
          />
        </div>

        <div className="grid min-[650px]:grid-cols-2 min-[900px]:grid-cols-3 min-[1200px]:grid-cols-4 gap-4 w-full max-w-6xl mx-auto px-6">
          {filteredUseCases.map((useCase: UseCase) => (
            <div
              key={useCase.id}
              className={cn(
                "rounded-xl overflow-hidden relative h-fit min-[650px]:h-full flex flex-col",
                useCase.featured
                  ? "md:shadow-[0px_61px_24px_-10px_rgba(0,0,0,0.01),0px_34px_20px_-8px_rgba(0,0,0,0.05),0px_15px_15px_-6px_rgba(0,0,0,0.09),0px_4px_8px_-2px_rgba(0,0,0,0.10),0px_0px_0px_1px_rgba(0,0,0,0.08)] bg-accent"
                  : "bg-[#F3F4F6] dark:bg-[#F9FAFB]/[0.02] border border-border",
              )}
            >
              <div className="flex flex-col gap-4 p-4">
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-secondary/10 p-2">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-secondary">
                      {useCase.icon}
                    </svg>
                  </div>
                  <h3 className="text-lg font-medium line-clamp-1">{useCase.title}</h3>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed line-clamp-3">
                  {useCase.description.replace(/Kortix/g, "Suna")}
                </p>
              </div>
              
              <div className="mt-auto">
                
                <hr className="border-border dark:border-white/20 m-0" />
                
                <div className="w-full h-[160px] bg-accent/10">
                  <div className="relative w-full h-full overflow-hidden">
                    <img 
                      src={`https://placehold.co/800x400/f5f5f5/666666?text=Suna+${useCase.title.split(' ').join('+')}`}
                      alt={`Suna ${useCase.title}`}
                      className="w-full h-full object-cover"
                    />
                    <Link
                      href={`/replays/${useCase.id}`}
                      className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 hover:opacity-100 transition-opacity flex items-end justify-start p-4 group"
                    >
                      <span className="flex items-center gap-2 text-sm text-white font-medium">
                        Watch replay 
                        <ArrowRight className="size-4 transform group-hover:translate-x-1 transition-transform" />
                      </span>
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
        
        {filteredUseCases.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-muted-foreground">No use cases found for this category yet.</p>
            <button 
              onClick={() => setActiveCategory('featured')} 
              className="mt-4 h-10 flex items-center justify-center text-sm font-normal tracking-wide rounded-full px-4 bg-primary text-primary-foreground shadow-[inset_0_1px_2px_rgba(255,255,255,0.25),0_3px_3px_-1.5px_rgba(16,24,40,0.06),0_1px_1px_rgba(16,24,40,0.08)]"
            >
              View featured use cases
            </button>
          </div>
        )}
      </div>
    </section>
  );
} 