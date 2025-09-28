# Adentic/Adentic Rebranding Plan

## Overview
This document outlines all branding elements identified in the codebase and provides a comprehensive plan for rebranding.

## 1. Image Assets to Replace

### Frontend Images (`frontend/public/`)
- `adentic-logo.svg` - Main logo
- `adentic-logo-white.svg` - White version of logo
- `adentic-symbol.svg` - Symbol/icon version
- `favicon.png` - Browser favicon
- `banner.png` - Marketing banner
- `thumbnail-dark.png` - Dark theme thumbnail
- `thumbnail-light.png` - Light theme thumbnail

### Frontend App Icon (`frontend/src/app/`)
- `favicon.ico` - Browser favicon

### Mobile App Assets (`apps/mobile/assets/images/`)
- `icon.png` - Mobile app icon
- `favicon.png` - Mobile favicon
- `adaptive-icon.png` - Android adaptive icon
- `adentic-logo-square.svg` - Square logo variant

## 2. Text/String References

### Configuration Files
1. **frontend/package.json**
   - `"name": "Adentic"` (line 2)

2. **frontend/src/lib/site.ts**
   - `name: 'TryAdentic'` (line 2)
   - `description: 'TryAdentic'` (line 4)
   - Social links referencing adentic domains

### Python Files
1. **setup.py**
   - Multiple references to "Adentic" in UI strings
   - "Adentic" admin API key references
   - Environment variable: `ADENTIC_ADMIN_API_KEY`

2. **start.py**
   - "Adentic" service management strings
   - UI messages about starting/stopping Adentic

### React/TypeScript Components
Multiple component files contain branding:
- `frontend/src/components/sidebar/adentic-logo.tsx`
- `frontend/src/components/sidebar/adentic-enterprise-modal.tsx`
- Various UI components with "Adentic" or "Adentic" text

### Environment Variables
- `ADENTIC_ADMIN_API_KEY` - Used in backend configuration

## 3. Rebranding Categories

### A. Visual Assets
1. **Logo Files** (6 files)
   - Main logos (SVG)
   - Favicon files (PNG/ICO)
   - Mobile app icons

2. **Marketing Assets** (3 files)
   - Banner images
   - Thumbnails

### B. Text Content
1. **Product Names**
   - "Adentic" → [NEW_BRAND_NAME]
   - "Adentic" → [NEW_PRODUCT_NAME]
   - "TryAdentic" → [NEW_COMPANY_NAME]

2. **URLs & Links**
   - GitHub: `github.com/adentic-ai/`
   - Twitter: `x.com/adenticai`
   - LinkedIn: `linkedin.com/company/adentic/`
   - Website: `adentic.so`

3. **Environment Variables**
   - `ADENTIC_*` prefixed variables

4. **Component Names**
   - Files with "adentic" in filename
   - React components with Adentic branding

## 4. File Count Summary
- **Image files to replace**: 12 files
- **Configuration files**: 3 files (package.json, site.ts, .env templates)
- **Python files**: 2 main files (setup.py, start.py)
- **React components**: ~30 files with references
- **Total estimated files**: ~50 files

## 5. Rebranding Steps

### Phase 1: Preparation
1. Create new logo assets (all formats)
2. Prepare new marketing materials
3. Define new brand names and URLs

### Phase 2: Asset Replacement
1. Replace all image files
2. Update favicon and app icons
3. Update marketing materials

### Phase 3: Code Updates
1. Update configuration files
2. Replace text strings in Python files
3. Update React component text
4. Rename component files if needed
5. Update environment variables

### Phase 4: Testing
1. Visual verification of logos
2. Test all links and references
3. Verify mobile app appearance
4. Check environment variable usage

## 6. Automation Script Requirements

The rebranding script should:
1. Accept new brand configuration (names, URLs, etc.)
2. Backup original files
3. Replace image files from a source directory
4. Update text content using regex patterns
5. Rename files with brand names
6. Update environment variable names
7. Generate a change report
8. Optionally revert changes

## Next Steps
1. Define new brand identity
2. Create replacement assets
3. Review and approve this plan
4. Implement rebranding script
5. Execute rebranding process