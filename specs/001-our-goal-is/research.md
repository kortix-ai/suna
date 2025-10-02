# Research & Discovery: Platform Rebranding to Adentic

## Overview
This document captures research findings and technical decisions for the Adentic rebranding feature.

## Key Research Areas

### 1. Brand Asset Requirements

**Decision**: Use provided brand assets from `/branding/` folder
**Rationale**: Client has provided logo images and comprehensive branding PDF
**Alternatives considered**:
- Creating new assets from scratch - rejected as client provided assets
- Using placeholder assets - rejected as real assets are available

### 2. Color System Implementation

**Decision**: Primary color #CC3A00 for both light and dark modes
**Rationale**: Client specified this color and confirmed it should be used consistently
**Alternatives considered**:
- Different shade for dark mode - rejected per client clarification
- Color palette generation - unnecessary, single primary color specified

### 3. Frontend Brand Integration Points

**Decision**: Update Tailwind CSS configuration and component styles
**Rationale**: Centralized color management through Tailwind config ensures consistency
**Key files identified**:
- `frontend/tailwind.config.js` - Primary color configuration
- `frontend/src/styles/globals.css` - CSS variables for brand colors
- `frontend/src/lib/constants.ts` - Brand name and text constants

### 4. Backend Email Template Strategy

**Decision**: Update transactional email templates with keyword replacement
**Rationale**: Client specified partial scope - transactional emails only, with keyword updates across all
**Key areas identified**:
- Password reset emails
- Account confirmation emails
- System notification templates
- Keyword replacement: "Kortix" → "Adentic" throughout

### 5. SEO and Metadata Updates

**Decision**: Update Next.js metadata API configuration
**Rationale**: Next.js 15 uses the Metadata API for SEO configuration
**Key updates needed**:
- Site title: "Adentic"
- Description: Update to reflect Adentic branding
- OpenGraph metadata
- Twitter card metadata
- Favicon and apple-touch-icon

### 6. Static Asset Management

**Decision**: Place processed logos in `frontend/public/` directory
**Rationale**: Next.js serves static assets from public directory with automatic optimization
**Asset requirements**:
- Logo variations (light/dark if needed)
- Favicon (multiple sizes)
- OpenGraph image
- Email header logo

### 7. Configuration Management

**Decision**: Centralize brand configuration in environment variables and constants files
**Rationale**: Makes future rebranding easier and maintains single source of truth
**Implementation**:
- Frontend: `frontend/src/lib/constants.ts`
- Backend: `backend/core/config/brand.py`
- Environment variables for external service names

### 8. Cache Handling Strategy

**Decision**: Manual cache clearing is acceptable
**Rationale**: No active customers, per client clarification
**Implementation**: No cache-busting mechanisms needed

### 9. Social Media Links

**Decision**: Update LinkedIn to provided URL, maintain other social links as-is
**Rationale**: Client specified LinkedIn update only
**LinkedIn URL**: https://www.linkedin.com/company/tryadentic

### 10. Copyright Text Format

**Decision**: Use "© 2025 Adentic. All rights reserved."
**Rationale**: Client confirmed this format in clarifications
**Implementation**: Update footer component and email footers

## Technical Constraints

- No new API endpoints required (UI/config changes only)
- No database schema changes needed
- No changes to agent execution or sandboxing
- No LLM integration changes
- Existing Docker containers remain unchanged

## Risk Assessment

**Low Risk Areas**:
- Static asset replacement
- Color configuration updates
- Text content changes

**Medium Risk Areas**:
- Email template updates (testing required)
- SEO metadata changes (verify search console after deployment)

**Mitigation**:
- Comprehensive testing of email templates
- Visual regression testing for UI changes
- SEO validation tools for metadata verification

## Next Steps

1. Process brand assets from `/branding/` folder
2. Generate required asset variations (favicon sizes, etc.)
3. Create brand configuration modules
4. Update component styles and templates
5. Test all touchpoints for consistency

## Conclusion

The rebranding to Adentic is primarily a configuration and asset update task with no architectural changes required. The main complexity lies in ensuring consistency across all touchpoints and thorough testing of the changes.