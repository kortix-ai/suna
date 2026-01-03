import { icons } from 'lucide-react';

/**
 * Converts kebab-case to PascalCase
 * Example: "message-circle" -> "MessageCircle"
 */
function toPascalCase(str: string): string {
  return str
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

/**
 * Converts PascalCase to kebab-case
 * Example: "MessageCircle" -> "message-circle"
 */
function toKebabCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Validates if an icon name exists in lucide-react
 * Accepts both kebab-case and PascalCase formats
 */
export function isValidIconName(iconName: string | null | undefined): boolean {
  if (!iconName || typeof iconName !== 'string') {
    return false;
  }

  // Check if it's already in PascalCase format
  if (icons[iconName as keyof typeof icons]) {
    return true;
  }

  // Try converting from kebab-case to PascalCase
  const pascalCaseName = toPascalCase(iconName);
  if (icons[pascalCaseName as keyof typeof icons]) {
    return true;
  }

  return false;
}

/**
 * Normalizes an icon name to kebab-case format for use with DynamicIcon
 * DynamicIcon expects kebab-case names like "message-circle", not PascalCase
 * Returns null if the icon doesn't exist
 */
export function normalizeIconName(iconName: string | null | undefined): string | null {
  if (!iconName || typeof iconName !== 'string') {
    return null;
  }

  // Check if it's already in PascalCase format (valid icon)
  if (icons[iconName as keyof typeof icons]) {
    // Convert PascalCase to kebab-case for DynamicIcon
    return toKebabCase(iconName);
  }

  // Try converting from kebab-case to PascalCase to validate
  const pascalCaseName = toPascalCase(iconName);
  if (icons[pascalCaseName as keyof typeof icons]) {
    // Return the original kebab-case (or convert to ensure proper format)
    return toKebabCase(pascalCaseName);
  }

  return null;
}

