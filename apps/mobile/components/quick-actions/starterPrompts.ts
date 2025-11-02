/**
 * Starter Prompts for Quick Actions
 * 
 * Provides sample prompts for each quick action mode.
 * These are minimal examples to inspire users and demonstrate capabilities.
 */

export interface StarterPrompt {
  id: string;
  text: string;
}

// Minimal prompts - focused on variety and inspiration
const STARTER_PROMPTS: Record<string, string[]> = {
  image: [
    'A majestic golden eagle soaring through misty mountain peaks at sunrise',
    'Close-up portrait of a fashion model with avant-garde makeup and studio lighting',
    'Cozy Scandinavian living room with natural wood furniture and indoor plants',
    'Futuristic cyberpunk street market at night with neon signs and holographic displays',
    'Elegant product photography of luxury perfume bottle on marble surface',
    'Whimsical floating islands connected by rope bridges in a pastel sky',
    'Macro close-up of morning dew drops on vibrant flower petals',
    'Modern workspace desk setup with laptop, coffee, and succulent plants from above',
  ],
  slides: [
    'Create a Series A pitch deck with market size, traction, and financial projections',
    'Build a Q4 business review showcasing KPIs, wins, and strategic initiatives',
    'Design a product launch presentation with demo videos and customer testimonials',
    'Develop a sales enablement deck explaining our value prop and competitive advantages',
    'Create an investor update highlighting key metrics and upcoming milestones',
    'Build a customer case study presentation showing ROI and success metrics',
  ],
  data: [
    'Build a financial model projecting ARR growth with different pricing scenarios',
    'Create an interactive sales dashboard tracking metrics by region and quarter',
    'Analyze customer reviews and visualize sentiment trends over time',
    'Design a content calendar tracking campaigns with ROI and engagement charts',
    'Build a cohort analysis showing user retention and churn patterns',
    'Create a marketing attribution model comparing channel performance',
  ],
  docs: [
    'Write a comprehensive PRD for an AI-powered recommendation engine',
    'Draft a technical architecture document for a scalable microservices platform',
    'Create a go-to-market strategy document for our Q2 product launch',
    'Develop a 90-day onboarding playbook for engineering managers',
    'Write an API documentation guide with examples and best practices',
    'Create a company handbook covering culture, policies, and benefits',
  ],
  people: [
    'Find VP of Engineering candidates at Series B+ AI/ML startups in San Francisco',
    'Build lead list of CMOs at B2B SaaS companies who recently raised Series A/B',
    'Research Senior Blockchain Engineers with Solidity experience',
    'Generate prospect list of technical founders at Seed-Series A startups in Enterprise AI',
    'Identify Senior Product Managers at fintech companies with FAANG experience',
    'Find CIOs at mid-market healthcare IT companies planning cloud migration',
  ],
  research: [
    'Analyze emerging trends in quantum computing and potential business applications',
    'Research top 10 competitors in the AI-powered CRM space with feature comparison',
    'Investigate regulatory requirements for launching a fintech app in the EU',
    'Compile market analysis on electric vehicle adoption rates across major markets',
    'Study the impact of remote work on commercial real estate demand',
    'Research Web3 adoption patterns among Fortune 500 companies',
  ],
};

/**
 * Get all starter prompts for a specific quick action
 */
export function getStarterPrompts(actionId: string): string[] {
  return STARTER_PROMPTS[actionId] || [];
}

/**
 * Get a random selection of starter prompts for a specific quick action
 */
export function getRandomPrompts(actionId: string, count: number = 3): string[] {
  const prompts = getStarterPrompts(actionId);
  if (prompts.length === 0) return [];
  
  // Shuffle and return the requested count
  const shuffled = [...prompts].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, prompts.length));
}

/**
 * Get a single random starter prompt for a specific quick action
 */
export function getRandomPrompt(actionId: string): string | null {
  const prompts = getRandomPrompts(actionId, 1);
  return prompts[0] || null;
}

