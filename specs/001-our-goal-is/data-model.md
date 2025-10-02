# Data Model: Platform Rebranding to Adentic

## Overview
This rebranding feature primarily involves configuration and asset updates rather than database schema changes. The data model consists of configuration constants and static assets.

## Configuration Entities

### BrandConfig (Frontend)
**Location**: `frontend/src/lib/constants.ts`
```typescript
interface BrandConfig {
  name: string;              // "Adentic"
  tagline?: string;          // Optional brand tagline
  primaryColor: string;      // "#CC3A00"
  copyrightText: string;     // "© 2025 Adentic. All rights reserved."
  social: {
    linkedin: string;        // "https://www.linkedin.com/company/tryadentic"
    twitter?: string;        // Existing link maintained
    github?: string;         // Existing link maintained
  };
}
```

**Validation Rules**:
- `name`: Required, non-empty string
- `primaryColor`: Required, valid hex color format
- `copyrightText`: Required, non-empty string
- `social.linkedin`: Required, valid URL format

### BrandAssets (Static Files)
**Location**: `frontend/public/`
```
interface BrandAssets {
  logo: {
    primary: string;         // "/logo.svg" or "/logo.png"
    icon: string;           // "/icon.svg" for small displays
    favicon: string;        // "/favicon.ico"
    appleTouchIcon: string; // "/apple-touch-icon.png"
  };
  openGraph: {
    image: string;          // "/og-image.png" (1200x630)
  };
}
```

**Requirements**:
- All paths must resolve to actual files in public directory
- Favicon must include multiple sizes (16x16, 32x32, etc.)
- OpenGraph image should be 1200x630 for optimal display

### EmailBrandConfig (Backend)
**Location**: `backend/core/config/brand.py`
```python
class EmailBrandConfig:
    brand_name: str = "Adentic"
    primary_color: str = "#CC3A00"
    logo_url: str = "https://[domain]/logo.png"
    copyright_text: str = "© 2025 Adentic. All rights reserved."
    support_email: str = "support@adentic.com"  # If applicable
```

**Validation Rules**:
- `brand_name`: Required, used in email subject lines and body
- `primary_color`: Used for email template styling
- `logo_url`: Must be absolute URL for email clients
- All fields must be non-empty strings

### SEOMetadata (Frontend)
**Location**: `frontend/src/app/layout.tsx` and page-specific metadata
```typescript
interface SEOMetadata {
  title: string;              // "Adentic - [Page Title]"
  description: string;        // Page-specific or default brand description
  keywords?: string[];        // SEO keywords
  openGraph: {
    title: string;
    description: string;
    url: string;
    siteName: string;        // "Adentic"
    images: [{
      url: string;
      width: number;
      height: number;
      alt: string;
    }];
  };
  twitter: {
    card: string;            // "summary_large_image"
    title: string;
    description: string;
    images: string[];
  };
}
```

## State Transitions

This feature does not involve stateful entities with transitions. All changes are static configuration updates.

## Relationships

```
BrandConfig
    ├── Used by → All frontend components
    ├── Referenced in → SEOMetadata
    └── Provides → Social links, colors, text

BrandAssets
    ├── Displayed in → Frontend UI components
    ├── Referenced by → SEOMetadata.openGraph.images
    └── Embedded in → Email templates

EmailBrandConfig
    └── Used by → Email service for template rendering

SEOMetadata
    ├── Consumes → BrandConfig.name
    ├── References → BrandAssets.openGraph.image
    └── Applied to → Next.js pages
```

## Data Migration

No database migrations required. This is a configuration-only change.

## Caching Considerations

- Frontend assets: Served with standard Next.js static file caching
- Email templates: May be cached by email service, manual clear if needed
- No cache invalidation strategy needed (manual clearing acceptable per requirements)

## Security Considerations

- No sensitive data in brand configuration
- All brand assets are public
- Copyright text is public information
- Social media links are public URLs

## Future Extensibility

The configuration structure allows for easy future rebranding by:
1. Updating configuration constants
2. Replacing asset files
3. No code changes needed in components (they reference config)

This design makes the platform "rebrand-ready" for potential future changes.