/**
 * Frontend validation utilities for file and folder names
 * Matches backend validation for consistent UX
 */

export interface ValidationResult {
  isValid: boolean;
  error?: string;
}

export class FileNameValidator {
  // Illegal characters for file/folder names (Windows + additional safety)
  private static readonly ILLEGAL_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
  
  // Reserved names (Windows)
  private static readonly RESERVED_NAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
  ]);

  /**
   * Sanitize a file/folder name by removing illegal characters
   */
  static sanitizeName(name: string): string {
    if (!name || !name.trim()) {
      return "Untitled";
    }

    // Remove leading/trailing whitespace
    name = name.trim();

    // Remove illegal characters
    name = name.replace(this.ILLEGAL_CHARS, '');

    // Remove leading/trailing dots and spaces (Windows issues)
    name = name.replace(/^[. ]+|[. ]+$/g, '');

    // Check if it's a reserved name
    const baseName = name.split('.')[0].toUpperCase();
    if (this.RESERVED_NAMES.has(baseName)) {
      name = `_${name}`;
    }

    // Limit length (conservative limit)
    if (new Blob([name]).size > 200) {
      name = name.substring(0, 200);
    }

    // If name becomes empty after sanitization
    if (!name) {
      return "Untitled";
    }

    return name;
  }

  /**
   * Validate a file/folder name
   */
  static validateName(name: string, itemType: 'file' | 'folder' = 'file'): ValidationResult {
    if (!name || !name.trim()) {
      return {
        isValid: false,
        error: `${itemType.charAt(0).toUpperCase() + itemType.slice(1)} name cannot be empty`
      };
    }

    const trimmedName = name.trim();

    // Check length
    if (trimmedName.length > 255) {
      return {
        isValid: false,
        error: `${itemType.charAt(0).toUpperCase() + itemType.slice(1)} name is too long (max 255 characters)`
      };
    }

    if (new Blob([trimmedName]).size > 200) {
      return {
        isValid: false,
        error: `${itemType.charAt(0).toUpperCase() + itemType.slice(1)} name is too long when encoded`
      };
    }

    // Check for illegal characters
    const illegalMatch = trimmedName.match(this.ILLEGAL_CHARS);
    if (illegalMatch) {
      const illegalChars = [...new Set(illegalMatch)];
      return {
        isValid: false,
        error: `${itemType.charAt(0).toUpperCase() + itemType.slice(1)} name contains illegal characters: ${illegalChars.join(', ')}`
      };
    }

    // Check for leading/trailing dots or spaces
    if (/^[. ]|[. ]$/.test(trimmedName)) {
      return {
        isValid: false,
        error: `${itemType.charAt(0).toUpperCase() + itemType.slice(1)} name cannot start or end with dots or spaces`
      };
    }

    // Check for reserved names
    const baseName = trimmedName.split('.')[0].toUpperCase();
    if (this.RESERVED_NAMES.has(baseName)) {
      return {
        isValid: false,
        error: `${itemType.charAt(0).toUpperCase() + itemType.slice(1)} name '${baseName}' is reserved by the system`
      };
    }

    // Check for dots-only names
    if (/^\.+$/.test(trimmedName)) {
      return {
        isValid: false,
        error: `${itemType.charAt(0).toUpperCase() + itemType.slice(1)} name cannot consist only of dots`
      };
    }

    return { isValid: true };
  }

  /**
   * Check if a name would conflict with existing names (case-insensitive)
   */
  static checkNameConflict(name: string, existingNames: string[]): boolean {
    const lowerName = name.toLowerCase();
    return existingNames.some(existing => existing.toLowerCase() === lowerName);
  }

  /**
   * Generate a friendly error message for common issues
   */
  static getFriendlyErrorMessage(name: string, itemType: 'file' | 'folder' = 'file'): string | null {
    const validation = this.validateName(name, itemType);
    if (validation.isValid) {
      return null;
    }

    // Provide more user-friendly messages for common issues
    if (!name || !name.trim()) {
      return `Please enter a ${itemType} name`;
    }

    if (name.length > 255) {
      return `${itemType.charAt(0).toUpperCase() + itemType.slice(1)} name is too long. Please use a shorter name.`;
    }

    if (this.ILLEGAL_CHARS.test(name)) {
      return `${itemType.charAt(0).toUpperCase() + itemType.slice(1)} name contains special characters that aren't allowed. Please use only letters, numbers, spaces, dots, hyphens, and underscores.`;
    }

    return validation.error || `Invalid ${itemType} name`;
  }

  /**
   * Generate a unique name by appending numbers like macOS does (synchronous version).
   * e.g., "document.txt" -> "document 2.txt" -> "document 3.txt"
   */
  static generateUniqueNameSync(baseName: string, existingNames: string[], itemType: 'file' | 'folder' = 'file'): string {
    // First, sanitize the base name
    const sanitizedBase = this.sanitizeName(baseName);
    
    // Check if base name is already unique
    if (!this.checkNameConflict(sanitizedBase, existingNames)) {
      return sanitizedBase;
    }

    // Split name and extension for files
    let namePart: string;
    let ext: string;
    
    if (itemType === "file" && sanitizedBase.includes('.')) {
      const lastDotIndex = sanitizedBase.lastIndexOf('.');
      namePart = sanitizedBase.substring(0, lastDotIndex);
      ext = sanitizedBase.substring(lastDotIndex);
    } else {
      namePart = sanitizedBase;
      ext = '';
    }

    // Find a unique name
    let counter = 2;
    while (true) {
      const newName = `${namePart} ${counter}${ext}`;
      if (!this.checkNameConflict(newName, existingNames)) {
        return newName;
      }
      counter++;
      
      // Safety break (shouldn't happen in normal use)
      if (counter > 1000) {
        const uniqueId = Math.random().toString(36).substring(2, 10);
        return `${namePart}_${uniqueId}${ext}`;
      }
    }
  }
}

/**
 * Hook for real-time name validation with debouncing
 */
export function useNameValidation(name: string, itemType: 'file' | 'folder' = 'file', existingNames: string[] = []) {
  const validation = FileNameValidator.validateName(name, itemType);
  const hasConflict = validation.isValid && FileNameValidator.checkNameConflict(name, existingNames);
  
  return {
    isValid: validation.isValid && !hasConflict,
    error: hasConflict 
      ? `A ${itemType} with this name already exists`
      : validation.error,
    friendlyError: hasConflict
      ? `A ${itemType} with this name already exists`
      : FileNameValidator.getFriendlyErrorMessage(name, itemType)
  };
}