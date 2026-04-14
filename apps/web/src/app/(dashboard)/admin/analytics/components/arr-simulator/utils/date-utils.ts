// Get current date in Berlin timezone
export function getBerlinToday(): Date {
  const now = new Date();
  // Format in Berlin timezone to get the correct date
  const berlinDate = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' }); // YYYY-MM-DD format
  const [year, month, day] = berlinDate.split('-').map(Number);
  return new Date(year, month - 1, day);
}

// Format a date as YYYY-MM-DD in Berlin timezone (avoids toISOString UTC conversion)
export function formatDateBerlin(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
}

// Helper to determine monthIndex from date: Dec 2025 = 0, Jan 2026 = 1, etc.
export function getMonthIndex(date: Date): number {
  return date.getFullYear() === 2025 && date.getMonth() === 11 ? 0 : date.getMonth() + 1;
}

// Calculate current week number and month index for filtering chart data (Berlin timezone)
export function getCurrentPeriod(): { currentWeekNumber: number; currentMonthIndex: number } {
  const startDate = new Date(2025, 11, 15); // Dec 15, 2025
  const today = getBerlinToday();
  const daysSinceStart = Math.floor((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
  const weekNum = Math.max(1, Math.floor(daysSinceStart / 7) + 1);

  // Month index: Dec 2025 = 0, Jan 2026 = 1, Feb 2026 = 2, etc.
  const monthIdx = today.getFullYear() === 2025 && today.getMonth() === 11 ? 0
    : today.getFullYear() === 2026 ? today.getMonth() + 1
    : 0;

  return { currentWeekNumber: weekNum, currentMonthIndex: monthIdx };
}

// Get week number from a date string (based on Dec 15, 2025 start)
export function getWeekNumber(dateStr: string): number {
  const startDate = new Date(2025, 11, 15); // Dec 15, 2025
  const date = new Date(dateStr);
  const daysSinceStart = Math.floor((date.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
  return Math.floor(daysSinceStart / 7) + 1;
}
