import { log } from '@/lib/logger';
/**
 * Mode Detection Utility
 * 
 * Automatically detects the appropriate mode for a thread based on the user's prompt content.
 * Uses keyword matching and scoring to determine the most relevant mode.
 */

export type ModeId = 'image' | 'slides' | 'data' | 'docs' | 'people' | 'research';

/**
 * Keyword patterns for each mode
 * Each entry contains:
 * - keywords: Array of phrases that indicate this mode
 * - weight: Higher weight = stronger signal for this mode
 */
interface ModePattern {
  keywords: string[];
  weight: number;
}

const MODE_PATTERNS: Record<ModeId, ModePattern[]> = {
  image: [
    // High confidence - explicit image generation
    { keywords: ['generate image', 'create image', 'make image', 'generate a image', 'create a image'], weight: 10 },
    { keywords: ['generate picture', 'create picture', 'make picture'], weight: 10 },
    { keywords: ['generate photo', 'create photo', 'make photo'], weight: 10 },
    { keywords: ['draw', 'drawing of', 'sketch', 'illustration'], weight: 8 },
    { keywords: ['design a logo', 'create logo', 'make logo', 'logo design'], weight: 9 },
    { keywords: ['photo of', 'picture of', 'image of'], weight: 7 },
    { keywords: ['artwork', 'art style', 'digital art'], weight: 8 },
    { keywords: ['wallpaper', 'background image', 'banner image'], weight: 7 },
    { keywords: ['icon', 'avatar', 'profile picture'], weight: 6 },
    // Medium confidence
    { keywords: ['visual', 'visualize', 'render'], weight: 4 },
    { keywords: ['graphic', 'graphics'], weight: 5 },
  ],
  
  slides: [
    // High confidence - explicit presentation
    { keywords: ['presentation', 'presentations'], weight: 10 },
    { keywords: ['slides', 'slide deck', 'slideshow'], weight: 10 },
    { keywords: ['powerpoint', 'ppt', 'keynote'], weight: 10 },
    { keywords: ['pitch deck', 'investor deck'], weight: 10 },
    { keywords: ['create slides', 'make slides', 'generate slides'], weight: 10 },
    { keywords: ['create presentation', 'make presentation', 'build presentation'], weight: 10 },
    // Medium confidence
    { keywords: ['deck about', 'deck on', 'deck for'], weight: 8 },
    { keywords: ['present', 'presenting'], weight: 4 },
  ],
  
  data: [
    // High confidence - explicit data work
    { keywords: ['spreadsheet', 'spread sheet'], weight: 10 },
    { keywords: ['csv', 'excel', 'xlsx', 'xls'], weight: 10 },
    { keywords: ['data analysis', 'analyze data', 'data analytics'], weight: 10 },
    { keywords: ['chart', 'charts', 'graph', 'graphs'], weight: 8 },
    { keywords: ['visualization', 'visualize data', 'data viz'], weight: 9 },
    { keywords: ['database', 'sql', 'query'], weight: 8 },
    { keywords: ['table', 'tables', 'tabular'], weight: 6 },
    { keywords: ['pivot', 'pivot table'], weight: 9 },
    { keywords: ['statistics', 'statistical'], weight: 7 },
    { keywords: ['dashboard', 'dashboards'], weight: 8 },
    // Medium confidence
    { keywords: ['metrics', 'kpi', 'kpis'], weight: 6 },
    { keywords: ['numbers', 'calculate', 'calculation'], weight: 4 },
    { keywords: ['analyze this', 'analyze the'], weight: 5 },
  ],
  
  docs: [
    // High confidence - explicit document creation
    { keywords: ['document', 'documents'], weight: 8 },
    { keywords: ['write a', 'write an', 'write the', 'write me'], weight: 7 },
    { keywords: ['essay', 'essays'], weight: 10 },
    { keywords: ['article', 'articles', 'blog post', 'blog article'], weight: 9 },
    { keywords: ['report', 'reports'], weight: 8 },
    { keywords: ['letter', 'letters', 'cover letter'], weight: 9 },
    { keywords: ['draft', 'drafting'], weight: 7 },
    { keywords: ['resume', 'cv', 'curriculum vitae'], weight: 10 },
    { keywords: ['proposal', 'proposals'], weight: 8 },
    { keywords: ['memo', 'memorandum'], weight: 9 },
    { keywords: ['contract', 'agreement'], weight: 8 },
    { keywords: ['email template', 'email draft'], weight: 7 },
    // Medium confidence
    { keywords: ['summary', 'summarize'], weight: 5 },
    { keywords: ['outline', 'outlines'], weight: 6 },
    { keywords: ['notes', 'note'], weight: 4 },
  ],
  
  people: [
    // High confidence - explicit people search
    { keywords: ['find people', 'find person', 'find someone'], weight: 10 },
    { keywords: ['contact', 'contacts', 'contact info'], weight: 8 },
    { keywords: ['linkedin', 'linked in'], weight: 10 },
    { keywords: ['who is', 'who are', 'who was'], weight: 7 },
    { keywords: ['email address', 'phone number'], weight: 8 },
    { keywords: ['ceo of', 'founder of', 'employee at'], weight: 9 },
    { keywords: ['reach out to', 'connect with'], weight: 7 },
    { keywords: ['profile', 'profiles'], weight: 5 },
    // Medium confidence
    { keywords: ['person', 'people'], weight: 3 },
    { keywords: ['team', 'team members'], weight: 4 },
    { keywords: ['company', 'organization'], weight: 3 },
  ],
  
  research: [
    // High confidence - explicit research
    { keywords: ['search for', 'search about', 'look up'], weight: 8 },
    { keywords: ['research', 'researching'], weight: 9 },
    { keywords: ['find information', 'find info', 'get information'], weight: 9 },
    { keywords: ['learn about', 'learn more about'], weight: 8 },
    { keywords: ['what is', 'what are', 'what was', 'what were'], weight: 6 },
    { keywords: ['how does', 'how do', 'how to', 'how can'], weight: 6 },
    { keywords: ['why does', 'why do', 'why is', 'why are'], weight: 6 },
    { keywords: ['explain', 'explaining'], weight: 5 },
    { keywords: ['tell me about', 'give me information'], weight: 7 },
    { keywords: ['investigate', 'investigation'], weight: 8 },
    { keywords: ['compare', 'comparison', 'vs', 'versus'], weight: 6 },
    // Medium confidence
    { keywords: ['understand', 'understanding'], weight: 4 },
    { keywords: ['define', 'definition'], weight: 5 },
    { keywords: ['history of', 'background of'], weight: 6 },
  ],
};

/**
 * Minimum score threshold to consider a mode detection confident
 * If no mode exceeds this threshold, we return null (fall back to selected tab)
 */
const CONFIDENCE_THRESHOLD = 6;

/**
 * Calculate the score for a specific mode based on keyword matches
 */
function calculateModeScore(normalizedPrompt: string, modeId: ModeId): number {
  const patterns = MODE_PATTERNS[modeId];
  let totalScore = 0;
  
  for (const pattern of patterns) {
    for (const keyword of pattern.keywords) {
      if (normalizedPrompt.includes(keyword)) {
        totalScore += pattern.weight;
        // Don't double-count overlapping keywords in the same pattern
        break;
      }
    }
  }
  
  return totalScore;
}

/**
 * Detect the most appropriate mode based on the content of the user's prompt
 * 
 * @param prompt - The user's message/prompt text
 * @returns The detected mode ID, or null if no confident detection
 */
export function detectModeFromContent(prompt: string): ModeId | null {
  if (!prompt || prompt.trim().length === 0) {
    return null;
  }
  
  // Normalize: lowercase and trim
  const normalizedPrompt = prompt.toLowerCase().trim();
  
  // Calculate scores for each mode
  const scores: Record<ModeId, number> = {
    image: calculateModeScore(normalizedPrompt, 'image'),
    slides: calculateModeScore(normalizedPrompt, 'slides'),
    data: calculateModeScore(normalizedPrompt, 'data'),
    docs: calculateModeScore(normalizedPrompt, 'docs'),
    people: calculateModeScore(normalizedPrompt, 'people'),
    research: calculateModeScore(normalizedPrompt, 'research'),
  };
  
  // Find the mode with highest score
  let bestMode: ModeId | null = null;
  let bestScore = 0;
  
  for (const [modeId, score] of Object.entries(scores) as [ModeId, number][]) {
    if (score > bestScore) {
      bestScore = score;
      bestMode = modeId;
    }
  }
  
  // Only return if we have confidence above threshold
  if (bestScore >= CONFIDENCE_THRESHOLD) {
    log.log(`[ModeDetection] Detected mode: ${bestMode} (score: ${bestScore})`, scores);
    return bestMode;
  }
  
  log.log(`[ModeDetection] No confident detection (best: ${bestMode} with score ${bestScore})`, scores);
  return null;
}

/**
 * Get all modes sorted by their score for a given prompt
 * Useful for debugging or showing suggestions
 */
export function getModeScores(prompt: string): Array<{ mode: ModeId; score: number }> {
  if (!prompt || prompt.trim().length === 0) {
    return [];
  }
  
  const normalizedPrompt = prompt.toLowerCase().trim();
  
  const scores: Array<{ mode: ModeId; score: number }> = [
    { mode: 'image', score: calculateModeScore(normalizedPrompt, 'image') },
    { mode: 'slides', score: calculateModeScore(normalizedPrompt, 'slides') },
    { mode: 'data', score: calculateModeScore(normalizedPrompt, 'data') },
    { mode: 'docs', score: calculateModeScore(normalizedPrompt, 'docs') },
    { mode: 'people', score: calculateModeScore(normalizedPrompt, 'people') },
    { mode: 'research', score: calculateModeScore(normalizedPrompt, 'research') },
  ];
  
  return scores.sort((a, b) => b.score - a.score);
}
