import type { VarianceResult } from '../../../types';

// Format currency values
export function formatCurrency(value: number): string {
  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(2)}M`;
  } else if (value >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`;
  }
  return `$${value.toFixed(0)}`;
}

// Format large numbers
export function formatNumber(value: number): string {
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(2)}M`;
  } else if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}K`;
  }
  return value.toLocaleString();
}

// Parse shorthand input: "25.5k" → 25500, "1.5M" → 1500000, "1000" → 1000
export function parseShorthand(input: string): number {
  if (!input || input.trim() === '') return 0;
  const cleaned = input.trim().toLowerCase();

  // Check for million suffix (M or m)
  if (cleaned.endsWith('m')) {
    const num = parseFloat(cleaned.slice(0, -1));
    return isNaN(num) ? 0 : Math.round(num * 1_000_000);
  }

  // Check for thousand suffix (K or k)
  if (cleaned.endsWith('k')) {
    const num = parseFloat(cleaned.slice(0, -1));
    return isNaN(num) ? 0 : Math.round(num * 1_000);
  }

  // Plain number
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : Math.round(num);
}

// Format number to shorthand for display: 25500 → "25.5k", 1500000 → "1.5M"
export function toShorthand(value: number): string {
  if (value === 0) return '';
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    // Show decimal only if needed, max 2 decimal places
    return m % 1 === 0 ? `${m}M` : `${parseFloat(m.toFixed(2))}M`;
  }
  if (value >= 1_000) {
    const k = value / 1_000;
    return k % 1 === 0 ? `${k}k` : `${parseFloat(k.toFixed(2))}k`;
  }
  return String(value);
}

// Calculate variance percentage
export function getVariance(actual: number | undefined, goal: number): VarianceResult {
  if (!actual || actual === 0) return { value: 0, color: 'text-muted-foreground' };
  const variance = ((actual - goal) / goal) * 100;
  if (variance >= 0) return { value: variance, color: 'text-green-600' };
  if (variance >= -10) return { value: variance, color: 'text-yellow-600' };
  return { value: variance, color: 'text-red-500' };
}

// Format date for display
export function formatDisplayDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// Format date with time for display
export function formatDisplayDateTime(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
