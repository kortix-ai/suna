# Quickstart: Adentic Rebranding Verification

## Overview
This guide provides step-by-step instructions to verify the Adentic rebranding has been successfully implemented across all platform touchpoints.

## Prerequisites
- Development environment set up with Docker
- Access to the branding folder with Adentic assets
- Frontend and backend services running

## Verification Steps

### 1. Prepare Brand Assets
```bash
# Navigate to branding folder
cd branding/

# Verify assets are present
ls -la *.jpeg *.pdf

# Expected files:
# - WhatsApp Image [...].jpeg (logo files)
# - Comprehensive Website Rebranding Analysis_ Adentic.pdf
```

### 2. Start the Platform
```bash
# From repository root
docker compose up -d

# Or for local development:
cd backend && uv run api.py  # Terminal 1
cd frontend && npm run dev    # Terminal 2
```

### 3. Visual Branding Verification

#### Homepage Check
1. Open browser to http://localhost:3000
2. Verify:
   - [ ] Adentic logo appears in header
   - [ ] Primary color #CC3A00 is visible in UI elements
   - [ ] Footer shows "© 2025 Adentic. All rights reserved."
   - [ ] Browser tab shows Adentic favicon

#### Social Links Check
1. Scroll to footer or social section
2. Verify:
   - [ ] LinkedIn link points to https://www.linkedin.com/company/tryadentic
   - [ ] Other social links are present and functional

#### Dark Mode Check (if applicable)
1. Toggle dark mode
2. Verify:
   - [ ] #CC3A00 primary color remains consistent
   - [ ] Logo displays correctly in dark mode
   - [ ] Text remains readable

### 4. SEO and Metadata Verification

#### Browser Tab Check
1. Look at browser tab title
2. Verify it shows "Adentic" or "Adentic - [Page Name]"

#### OpenGraph Check
```bash
# Use curl to check meta tags
curl -s http://localhost:3000 | grep -E "og:|twitter:"

# Should see:
# <meta property="og:site_name" content="Adentic">
# <meta property="og:image" content="/og-image.png">
```

#### View Page Source
1. Right-click on page → View Page Source
2. Search for "Adentic" - should appear in:
   - Title tag
   - Meta description
   - OpenGraph tags
   - Twitter card tags

### 5. Email Template Verification

#### Test Transactional Emails
1. Trigger a password reset:
   - Go to login page
   - Click "Forgot Password"
   - Enter test email
2. Check received email for:
   - [ ] Adentic branding in header
   - [ ] #CC3A00 color in buttons/links
   - [ ] Footer with "© 2025 Adentic. All rights reserved."
   - [ ] All instances of "Kortix" replaced with "Adentic"

#### Test Account Confirmation
1. Create a new test account
2. Check confirmation email for:
   - [ ] Adentic logo
   - [ ] Correct brand colors
   - [ ] Updated copy with Adentic name

### 6. Asset Loading Verification

#### Test Fallback Display
1. Open Developer Tools (F12)
2. Go to Network tab
3. Block logo image requests
4. Refresh page
5. Verify text "Adentic" appears as fallback

#### Cache Testing
1. Clear browser cache (Ctrl+Shift+Delete)
2. Reload page
3. Verify all brand assets load correctly

### 7. Configuration Verification

#### Frontend Constants
```bash
# Check frontend configuration
cat frontend/src/lib/constants.ts | grep -i adentic

# Should see brand name, colors, and social links
```

#### Backend Configuration
```bash
# Check backend configuration
cat backend/core/config/brand.py | grep -i adentic

# Should see email brand configuration
```

### 8. Cross-Browser Testing

Test on multiple browsers:
- [ ] Chrome - All branding displays correctly
- [ ] Firefox - All branding displays correctly
- [ ] Safari - All branding displays correctly
- [ ] Edge - All branding displays correctly

### 9. Mobile Responsiveness

1. Open Chrome DevTools (F12)
2. Toggle device emulation (Ctrl+Shift+M)
3. Test on different screen sizes:
   - [ ] Mobile (375px) - Logo scales appropriately
   - [ ] Tablet (768px) - Layout remains branded
   - [ ] Desktop (1920px) - Full branding visible

## Success Criteria

The rebranding is considered successful when:
- ✅ All visual elements display Adentic branding
- ✅ No references to "Kortix" remain visible
- ✅ Primary color #CC3A00 is consistently applied
- ✅ Copyright text shows "© 2025 Adentic. All rights reserved."
- ✅ LinkedIn link points to correct Adentic page
- ✅ Email templates use Adentic branding
- ✅ SEO metadata reflects Adentic brand
- ✅ Fallback text displays when images fail to load

## Troubleshooting

### Assets Not Displaying
- Verify files exist in `frontend/public/` directory
- Check browser console for 404 errors
- Ensure correct file paths in configuration

### Colors Not Updating
- Clear browser cache
- Check Tailwind CSS compilation
- Verify color values in `tailwind.config.js`

### Emails Still Show Old Branding
- Restart backend service
- Check email template cache
- Verify `backend/core/config/brand.py` is updated

## Rollback Plan

If issues are encountered:
1. Git revert the branding commits
2. Restore original assets to `frontend/public/`
3. Clear all caches
4. Restart services

## Completion Checklist

- [ ] All visual elements updated
- [ ] Email templates rebranded
- [ ] SEO metadata updated
- [ ] Social links configured
- [ ] Cross-browser tested
- [ ] Mobile responsive
- [ ] Documentation updated
- [ ] Stakeholder approval obtained

## Next Steps

After successful verification:
1. Commit all changes with message: "feat: rebrand platform to Adentic"
2. Create PR for review
3. Deploy to staging environment
4. Perform final verification on staging
5. Deploy to production (when applicable)