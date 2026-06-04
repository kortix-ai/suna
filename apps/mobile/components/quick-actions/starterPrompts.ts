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

/**
 * Get all starter prompts for a specific quick action using translations
 */
export function getStarterPrompts(actionId: string, t: (key: string, options?: any) => any): string[] {
  const prompts = t(`quickActions.starterPrompts.${actionId}`, { returnObjects: true });
  
  // Handle both array and string return types from i18n
  if (Array.isArray(prompts)) {
    // Ensure all items are strings
    return prompts.filter((p): p is string => typeof p === 'string');
  }
  
  // Fallback to empty array if translation not found
  return [];
}

/**
 * Get a random selection of starter prompts for a specific quick action
 */
export function getRandomPrompts(actionId: string, count: number = 3, t: (key: string, options?: any) => any): string[] {
  const prompts = getStarterPrompts(actionId, t);
  if (prompts.length === 0) return [];
  
  // Shuffle and return the requested count
  const shuffled = [...prompts].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, prompts.length));
}

/**
 * Get a single random starter prompt for a specific quick action
 */
export function getRandomPrompt(actionId: string, t: (key: string, options?: any) => any): string | null {
  const prompts = getRandomPrompts(actionId, 1, t);
  return prompts[0] || null;
}

