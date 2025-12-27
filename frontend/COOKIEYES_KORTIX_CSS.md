# Kortix CookieYes Custom CSS - Premium Brand Design

**Copy this entire CSS into CookieYes Dashboard → Customize → Advanced → Custom CSS**

```css
/* ============================================
   KORTIX - CookieYes Custom CSS
   Premium UX/UI - Matches Kortix Brand System
   ============================================ */

/* ============================================
   LOAD ROOBERT FONT FROM YOUR WEBSITE
   ============================================ */
@font-face {
  font-family: 'Roobert';
  src: url('https://www.kortix.com/fonts/roobert/RoobertUprightsVF.woff2') format('woff2');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
  font-feature-settings: 'salt' on, 'ss10' on, 'ss09' on, 'ss01' on, 'ss02' on, 'ss03' on, 'ss04' on, 'ss14' on;
}

@font-face {
  font-family: 'Roobert';
  src: url('https://www.kortix.com/fonts/roobert/RoobertItalicsVF.woff2') format('woff2');
  font-weight: 100 900;
  font-style: italic;
  font-display: swap;
  font-feature-settings: 'salt' on, 'ss10' on, 'ss09' on, 'ss01' on, 'ss02' on, 'ss03' on, 'ss04' on, 'ss14' on;
}

/* ============================================
   HIDE POWERED BY - COMPLETELY REMOVED
   ============================================ */
[data-cky-tag="powered-by"],
[data-cky-tag="detail-powered-by"],
[data-cky-tag="powered-by"] *,
[data-cky-tag="detail-powered-by"] *,
.cky-footer-wrapper > div:last-child,
.cky-footer-wrapper > div[style*="padding-bottom"],
.cky-footer-wrapper > div[style*="padding-bottom"] *,
.cky-consent-bar > div:last-child,
.cky-consent-bar > div[style*="padding-bottom"],
.cky-consent-bar > div[style*="padding-bottom"] * {
  display: none !important;
  visibility: hidden !important;
  opacity: 0 !important;
  height: 0 !important;
  width: 0 !important;
  overflow: hidden !important;
  position: absolute !important;
  pointer-events: none !important;
  margin: 0 !important;
  padding: 0 !important;
  font-size: 0 !important;
  line-height: 0 !important;
}

/* ============================================
   GLOBAL RESET & BASE
   ============================================ */
.cky-consent-container,
.cky-consent-container *,
.cky-preference-center,
.cky-preference-center * {
  font-family: 'Roobert', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
  box-sizing: border-box !important;
}

/* ============================================
   MAIN BANNER - Kortix Brand
   ============================================ */
.cky-consent-container {
  z-index: 999999 !important;
}

.cky-consent-bar,
.cky-consent-bar[data-cky-tag="notice"] {
  background: #fafafa !important;
  border: none !important;
  border-top: 1px solid rgba(0, 0, 0, 0.06) !important;
  box-shadow: none !important;
}

.cky-notice-content-wrapper {
  padding: 18px 24px !important;
  max-width: 1400px !important;
  margin: 0 auto !important;
}

.cky-notice {
  display: flex !important;
  align-items: center !important;
  gap: 24px !important;
  flex-wrap: wrap !important;
}

.cky-notice-group {
  display: flex !important;
  align-items: center !important;
  gap: 16px !important;
  flex: 1 !important;
  flex-wrap: wrap !important;
}

/* Banner Title - Completely Hidden */
.cky-title,
.cky-title[data-cky-tag="title"],
p.cky-title {
  display: none !important;
  visibility: hidden !important;
  height: 0 !important;
  width: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  opacity: 0 !important;
  overflow: hidden !important;
}

/* Banner Description - Kortix Typography */
.cky-notice-des,
.cky-notice-des p,
.cky-notice-des[data-cky-tag="description"],
.cky-notice-des[data-cky-tag="description"] p {
  font-size: 13px !important;
  font-weight: 400 !important;
  color: #555 !important;
  line-height: 1.5 !important;
  margin: 0 !important;
  flex: 1 !important;
  min-width: 280px !important;
}

/* Banner Button Container */
.cky-notice-btn-wrapper,
.cky-notice-btn-wrapper[data-cky-tag="notice-buttons"] {
  display: flex !important;
  gap: 8px !important;
  align-items: center !important;
  flex-wrap: nowrap !important;
  margin: 0 !important;
}

/* ============================================
   BUTTONS - Kortix Brand (Override ALL Inline Styles)
   ============================================ */
.cky-btn,
button.cky-btn {
  font-size: 13px !important;
  font-weight: 500 !important;
  line-height: 1 !important;
  padding: 10px 18px !important;
  border-radius: 8px !important;
  border: 1px solid transparent !important;
  transition: all 0.15s ease !important;
  cursor: pointer !important;
  outline: none !important;
  white-space: nowrap !important;
  text-decoration: none !important;
  font-family: 'Roobert', -apple-system, BlinkMacSystemFont, sans-serif !important;
}

/* Accept Button - Primary Black (Kortix Brand) */
.cky-btn-accept,
button.cky-btn-accept,
.cky-btn-accept[data-cky-tag="accept-button"],
button[data-cky-tag="accept-button"] {
  background: #0a0a0a !important;
  border-color: #0a0a0a !important;
  color: #fff !important;
  box-shadow: none !important;
}

.cky-btn-accept:hover,
button.cky-btn-accept:hover {
  background: #1a1a1a !important;
  border-color: #1a1a1a !important;
  box-shadow: none !important;
}

.cky-btn-accept:active {
  transform: scale(0.98) !important;
}

/* Reject Button - Secondary Ghost */
.cky-btn-reject,
button.cky-btn-reject,
.cky-btn-reject[data-cky-tag="reject-button"],
button[data-cky-tag="reject-button"] {
  background: transparent !important;
  border-color: rgba(0, 0, 0, 0.12) !important;
  color: #333 !important;
}

.cky-btn-reject:hover,
button.cky-btn-reject:hover {
  background: rgba(0, 0, 0, 0.04) !important;
  border-color: rgba(0, 0, 0, 0.2) !important;
}

/* Customize Button - Text Link Style */
.cky-btn-customize,
button.cky-btn-customize,
.cky-btn-customize[data-cky-tag="settings-button"],
button[data-cky-tag="settings-button"] {
  background: transparent !important;
  border-color: rgba(0, 0, 0, 0.12) !important;
  color: #333 !important;
}

.cky-btn-customize:hover,
button.cky-btn-customize:hover {
  background: rgba(0, 0, 0, 0.04) !important;
  border-color: rgba(0, 0, 0, 0.2) !important;
}

/* Save Preferences Button */
.cky-btn-preferences,
button.cky-btn-preferences,
.cky-btn-preferences[data-cky-tag="detail-save-button"],
button[data-cky-tag="detail-save-button"] {
  background: #0a0a0a !important;
  border-color: #0a0a0a !important;
  color: #fff !important;
}

.cky-btn-preferences:hover,
button.cky-btn-preferences:hover {
  background: #1a1a1a !important;
  border-color: #1a1a1a !important;
}

/* Focus States - Accessibility */
.cky-btn:focus-visible,
button.cky-btn:focus-visible {
  outline: 2px solid #0a0a0a !important;
  outline-offset: 2px !important;
}

/* ============================================
   PREFERENCE CENTER MODAL - Premium Design
   ============================================ */
.cky-modal,
.cky-modal[tabindex="-1"] {
  background: rgba(0, 0, 0, 0.4) !important;
  backdrop-filter: blur(8px) !important;
  -webkit-backdrop-filter: blur(8px) !important;
}

.cky-modal * {
  box-shadow: none !important;
}

.cky-preference-center,
.cky-preference-center[data-cky-tag="detail"],
.cky-preference-center[role="dialog"] {
  background: #fff !important;
  border: none !important;
  border-radius: 20px !important;
  box-shadow: none !important;
  max-width: 520px !important;
  width: calc(100% - 32px) !important;
  max-height: 80vh !important;
  overflow: hidden !important;
  display: flex !important;
  flex-direction: column !important;
  outline: none !important;
  isolation: isolate !important;
}

.cky-preference-center * {
  border-radius: 0 !important;
}

.cky-preference-center:focus,
.cky-preference-center:focus-visible {
  outline: none !important;
  box-shadow: none !important;
}

/* ============================================
   MODAL HEADER - Clean & Minimal
   ============================================ */
.cky-preference-header {
  padding: 24px 28px 20px !important;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06) !important;
  display: flex !important;
  align-items: flex-start !important;
  justify-content: space-between !important;
  flex-shrink: 0 !important;
  background: #fff !important;
  border-radius: 20px 20px 0 0 !important;
  overflow: hidden !important;
  position: relative !important;
  z-index: 1 !important;
}

.cky-preference-title,
.cky-preference-title[data-cky-tag="detail-title"],
span.cky-preference-title {
  font-size: 20px !important;
  font-weight: 600 !important;
  color: #0a0a0a !important;
  margin: 0 !important;
  letter-spacing: -0.02em !important;
  line-height: 1.3 !important;
}

/* Close Button - Minimal Circle */
.cky-btn-close,
button.cky-btn-close,
.cky-btn-close[data-cky-tag="detail-close"],
button[data-cky-tag="detail-close"] {
  width: 36px !important;
  height: 36px !important;
  min-width: 36px !important;
  border-radius: 50% !important;
  background: #f5f5f5 !important;
  border: none !important;
  cursor: pointer !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  transition: all 0.15s ease !important;
  margin-left: 16px !important;
  flex-shrink: 0 !important;
}

.cky-btn-close:hover,
button.cky-btn-close:hover {
  background: #eaeaea !important;
  transform: scale(1.05) !important;
}

.cky-btn-close:active,
button.cky-btn-close:active {
  transform: scale(0.95) !important;
}

.cky-btn-close img {
  width: 12px !important;
  height: 12px !important;
  opacity: 0.5 !important;
}

/* ============================================
   MODAL BODY - Scrollable Content
   ============================================ */
.cky-preference-body-wrapper {
  padding: 0 28px 20px !important;
  overflow-y: auto !important;
  flex: 1 !important;
  -webkit-overflow-scrolling: touch !important;
  background: #fff !important;
  position: relative !important;
  z-index: 0 !important;
}

/* Custom Scrollbar */
.cky-preference-body-wrapper::-webkit-scrollbar {
  width: 6px !important;
}

.cky-preference-body-wrapper::-webkit-scrollbar-track {
  background: transparent !important;
}

.cky-preference-body-wrapper::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.15) !important;
  border-radius: 3px !important;
}

.cky-preference-body-wrapper::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 0, 0, 0.25) !important;
}

/* Description Text */
.cky-preference-content-wrapper,
.cky-preference-content-wrapper[data-cky-tag="detail-description"] {
  margin-bottom: 20px !important;
}

.cky-preference-content-wrapper p,
.cky-preference-content-wrapper[data-cky-tag="detail-description"] p {
  font-size: 14px !important;
  color: #666 !important;
  line-height: 1.6 !important;
  margin: 0 0 8px 0 !important;
}

.cky-preference-content-wrapper p:last-child {
  margin-bottom: 0 !important;
}

.cky-show-desc-btn,
button.cky-show-desc-btn,
.cky-show-desc-btn[data-cky-tag="show-desc-button"],
button[data-cky-tag="show-desc-button"] {
  color: #0a0a0a !important;
  background: none !important;
  border: none !important;
  padding: 0 !important;
  font-size: 14px !important;
  font-weight: 500 !important;
  cursor: pointer !important;
  text-decoration: none !important;
  transition: opacity 0.15s ease !important;
}

.cky-show-desc-btn:hover,
button.cky-show-desc-btn:hover {
  opacity: 0.7 !important;
}

/* Hide Separator */
.cky-horizontal-separator {
  display: none !important;
}

/* ============================================
   ACCORDION - Modern Card Design
   ============================================ */
.cky-accordion-wrapper,
.cky-accordion-wrapper[data-cky-tag="detail-categories"] {
  display: flex !important;
  flex-direction: column !important;
  gap: 10px !important;
}

.cky-accordion,
.cky-accordion[id^="ckyDetailCategory"] {
  background: #fafafa !important;
  border: 1px solid rgba(0, 0, 0, 0.06) !important;
  border-radius: 14px !important;
  overflow: hidden !important;
  transition: all 0.2s ease !important;
  outline: none !important;
  box-shadow: none !important;
  margin: 0 !important;
  isolation: isolate !important;
}

.cky-accordion:hover {
  border-color: rgba(0, 0, 0, 0.1) !important;
  box-shadow: none !important;
}

.cky-accordion.cky-accordion-active {
  background: #f5f5f5 !important;
  border-color: rgba(0, 0, 0, 0.1) !important;
  box-shadow: none !important;
}

.cky-accordion:focus,
.cky-accordion:focus-visible {
  outline: none !important;
  box-shadow: none !important;
}

.cky-accordion-item {
  padding: 16px 18px 16px 44px !important;
  display: flex !important;
  align-items: flex-start !important;
  cursor: pointer !important;
  position: relative !important;
}

/* Hide Default Chevron Completely */
.cky-accordion-chevron {
  display: none !important;
  visibility: hidden !important;
  width: 0 !important;
  height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
}

.cky-chevron-right,
.cky-chevron-right::before,
.cky-chevron-right::after,
i.cky-chevron-right {
  display: none !important;
  visibility: hidden !important;
  width: 0 !important;
  height: 0 !important;
}

/* Custom Arrow Using Pseudo-element */
.cky-accordion-item::before {
  content: '' !important;
  position: absolute !important;
  left: 18px !important;
  top: 20px !important;
  width: 6px !important;
  height: 6px !important;
  border-right: 2px solid #888 !important;
  border-bottom: 2px solid #888 !important;
  transform: rotate(-45deg) !important;
  transition: transform 0.2s ease !important;
  pointer-events: none !important;
}

.cky-accordion-active .cky-accordion-item::before {
  transform: rotate(45deg) !important;
}

.cky-accordion-header-wrapper {
  flex: 1 !important;
  min-width: 0 !important;
}

.cky-accordion-header {
  display: flex !important;
  align-items: center !important;
  flex-wrap: wrap !important;
  gap: 10px !important;
  margin-bottom: 0 !important;
}

.cky-accordion-btn,
button.cky-accordion-btn,
.cky-accordion-btn[data-cky-tag="detail-category-title"],
button[data-cky-tag="detail-category-title"] {
  font-size: 14px !important;
  font-weight: 600 !important;
  color: #0a0a0a !important;
  background: none !important;
  border: none !important;
  padding: 0 !important;
  cursor: pointer !important;
  text-align: left !important;
  letter-spacing: -0.01em !important;
}

/* Always Active Badge - Pill Style */
.cky-always-active,
span.cky-always-active,
.cky-always-active[data-cky-tag="always-active"] {
  font-size: 11px !important;
  font-weight: 500 !important;
  color: #16a34a !important;
  background: rgba(22, 163, 74, 0.1) !important;
  padding: 4px 10px !important;
  border-radius: 100px !important;
  letter-spacing: 0 !important;
  line-height: 1 !important;
}

/* Category Description */
.cky-accordion-header-des,
.cky-accordion-header-des[data-cky-tag="detail-category-description"] {
  margin-top: 10px !important;
}

.cky-accordion-header-des p,
.cky-accordion-header-des[data-cky-tag="detail-category-description"] p {
  font-size: 13px !important;
  color: #666 !important;
  line-height: 1.5 !important;
  margin: 0 !important;
}

/* Accordion Body - Cookie Details */
.cky-accordion-body,
.cky-accordion-body[id$="Body"] {
  padding: 0 18px 16px 18px !important;
  animation: accordionOpen 0.2s ease !important;
}

@keyframes accordionOpen {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.cky-audit-table,
.cky-audit-table[data-cky-tag="audit-table"] {
  background: #fff !important;
  border: 1px solid rgba(0, 0, 0, 0.06) !important;
  border-radius: 10px !important;
  padding: 14px 16px !important;
  color: #888 !important;
  font-size: 13px !important;
  box-shadow: none !important;
  margin: 0 !important;
  overflow: hidden !important;
}

.cky-empty-cookies-text,
p.cky-empty-cookies-text {
  font-size: 13px !important;
  color: #888 !important;
  margin: 0 !important;
  font-style: italic !important;
}

/* ============================================
   TOGGLE SWITCHES - iOS Style
   ============================================ */
.cky-switch {
  position: relative !important;
  width: 44px !important;
  height: 26px !important;
  flex-shrink: 0 !important;
  margin-left: auto !important;
}

.cky-switch input {
  opacity: 0 !important;
  width: 0 !important;
  height: 0 !important;
}

.cky-slider {
  position: absolute !important;
  cursor: pointer !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  background-color: #e5e5e5 !important;
  border-radius: 26px !important;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
}

.cky-slider:before {
  position: absolute !important;
  content: "" !important;
  height: 22px !important;
  width: 22px !important;
  left: 2px !important;
  bottom: 2px !important;
  background-color: #fff !important;
  border-radius: 50% !important;
  box-shadow: none !important;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
}

.cky-switch input:checked + .cky-slider {
  background-color: #0a0a0a !important;
}

.cky-switch input:checked + .cky-slider:before {
  transform: translateX(18px) !important;
}

.cky-switch input:focus-visible + .cky-slider {
  outline: 2px solid #0a0a0a !important;
  outline-offset: 2px !important;
}

/* ============================================
   MODAL FOOTER - Sticky Actions
   ============================================ */
.cky-footer-wrapper {
  padding: 20px 28px 24px !important;
  background: #fff !important;
  border-top: 1px solid rgba(0, 0, 0, 0.06) !important;
  flex-shrink: 0 !important;
  position: relative !important;
  border-radius: 0 0 20px 20px !important;
  overflow: hidden !important;
  z-index: 1 !important;
}

.cky-footer-shadow {
  display: none !important;
  visibility: hidden !important;
  opacity: 0 !important;
  height: 0 !important;
  width: 0 !important;
  overflow: hidden !important;
  position: absolute !important;
  pointer-events: none !important;
  margin: 0 !important;
  padding: 0 !important;
}

.cky-prefrence-btn-wrapper,
.cky-prefrence-btn-wrapper[data-cky-tag="detail-buttons"] {
  display: flex !important;
  gap: 10px !important;
  justify-content: flex-end !important;
}

/* Footer Buttons - Slightly Larger */
.cky-prefrence-btn-wrapper .cky-btn,
.cky-prefrence-btn-wrapper button.cky-btn {
  padding: 12px 20px !important;
}

/* ============================================
   DARK MODE - Full Support
   ============================================ */
.dark .cky-consent-bar,
.dark .cky-consent-bar[data-cky-tag="notice"] {
  background: #1a1a1a !important;
  border-top-color: rgba(255, 255, 255, 0.06) !important;
  box-shadow: none !important;
}

.dark .cky-notice-des,
.dark .cky-notice-des p {
  color: #a0a0a0 !important;
}

.dark .cky-btn-accept,
.dark .cky-btn-preferences,
.dark button.cky-btn-accept,
.dark button.cky-btn-preferences {
  background: #fff !important;
  border-color: #fff !important;
  color: #0a0a0a !important;
}

.dark .cky-btn-accept:hover,
.dark .cky-btn-preferences:hover {
  background: #f0f0f0 !important;
  border-color: #f0f0f0 !important;
}

.dark .cky-btn-reject,
.dark .cky-btn-customize,
.dark button.cky-btn-reject,
.dark button.cky-btn-customize {
  background: transparent !important;
  border-color: rgba(255, 255, 255, 0.15) !important;
  color: #e0e0e0 !important;
}

.dark .cky-btn-reject:hover,
.dark .cky-btn-customize:hover {
  background: rgba(255, 255, 255, 0.08) !important;
  border-color: rgba(255, 255, 255, 0.25) !important;
}

.dark .cky-modal {
  background: rgba(0, 0, 0, 0.6) !important;
}

.dark .cky-preference-center {
  background: #1a1a1a !important;
  border: none !important;
  box-shadow: none !important;
}

.dark .cky-preference-header {
  background: #1a1a1a !important;
  border-bottom-color: rgba(255, 255, 255, 0.06) !important;
}

.dark .cky-preference-body-wrapper {
  background: #1a1a1a !important;
}

.dark .cky-footer-wrapper {
  background: #1a1a1a !important;
  border-top-color: rgba(255, 255, 255, 0.06) !important;
}

.dark .cky-preference-title {
  color: #fff !important;
}

.dark .cky-btn-close {
  background: #2a2a2a !important;
}

.dark .cky-btn-close:hover {
  background: #3a3a3a !important;
}

.dark .cky-btn-close img {
  filter: invert(1) !important;
}

.dark .cky-preference-content-wrapper p {
  color: #888 !important;
}

.dark .cky-show-desc-btn {
  color: #fff !important;
}

.dark .cky-accordion {
  background: #222 !important;
  border-color: rgba(255, 255, 255, 0.06) !important;
}

.dark .cky-accordion:hover {
  border-color: rgba(255, 255, 255, 0.1) !important;
}

.dark .cky-accordion.cky-accordion-active {
  background: #252525 !important;
}

.dark .cky-accordion-btn {
  color: #fff !important;
}

.dark .cky-accordion-header-des p {
  color: #888 !important;
}

.dark .cky-accordion-item::before {
  border-color: #666 !important;
}

.dark .cky-always-active {
  color: #4ade80 !important;
  background: rgba(74, 222, 128, 0.12) !important;
}

.dark .cky-audit-table {
  background: #1a1a1a !important;
  border-color: rgba(255, 255, 255, 0.06) !important;
  color: #666 !important;
}

.dark .cky-empty-cookies-text {
  color: #666 !important;
}

.dark .cky-slider {
  background-color: #404040 !important;
}

.dark .cky-switch input:checked + .cky-slider {
  background-color: #fff !important;
}

.dark .cky-switch input:checked + .cky-slider:before {
  background-color: #0a0a0a !important;
}

/* ============================================
   RESPONSIVE - Mobile First
   ============================================ */
@media (max-width: 640px) {
  .cky-consent-bar {
    position: fixed !important;
    bottom: 0 !important;
    left: 0 !important;
    right: 0 !important;
  }
  
  .cky-notice-content-wrapper {
    padding: 16px 20px !important;
  }
  
  .cky-notice {
    flex-direction: column !important;
    align-items: stretch !important;
    gap: 16px !important;
  }
  
  .cky-notice-group {
    flex-direction: column !important;
    align-items: stretch !important;
  }
  
  .cky-notice-des {
    min-width: 0 !important;
  }
  
  .cky-notice-btn-wrapper {
    flex-wrap: wrap !important;
  }
  
  .cky-notice-btn-wrapper .cky-btn {
    flex: 1 !important;
    min-width: 120px !important;
    justify-content: center !important;
    text-align: center !important;
  }
  
  .cky-preference-center {
    margin: 12px !important;
    max-height: calc(100vh - 24px) !important;
    border-radius: 16px !important;
    width: calc(100% - 24px) !important;
    box-shadow: none !important;
  }
  
  .cky-preference-header {
    padding: 20px 20px 16px !important;
  }
  
  .cky-preference-title {
    font-size: 18px !important;
  }
  
  .cky-preference-body-wrapper {
    padding: 0 20px 16px !important;
  }
  
  .cky-accordion-item {
    padding: 14px 16px 14px 40px !important;
  }
  
  .cky-accordion-item::before {
    left: 16px !important;
    top: 18px !important;
  }
  
  .cky-accordion-body {
    padding: 0 16px 14px 16px !important;
  }
  
  .cky-footer-wrapper {
    padding: 16px 20px 20px !important;
  }
  
  .cky-prefrence-btn-wrapper {
    flex-direction: column-reverse !important;
  }
  
  .cky-prefrence-btn-wrapper .cky-btn {
    width: 100% !important;
    justify-content: center !important;
    text-align: center !important;
  }
}

/* ============================================
   ANIMATIONS - Smooth & Subtle
   ============================================ */
.cky-consent-bar {
  animation: bannerSlideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) !important;
}

@keyframes bannerSlideUp {
  from {
    transform: translateY(100%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.cky-modal {
  animation: modalFadeIn 0.25s ease !important;
}

@keyframes modalFadeIn {
  from { 
    opacity: 0; 
  }
  to { 
    opacity: 1; 
  }
}

.cky-preference-center {
  animation: modalScaleIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) !important;
}

@keyframes modalScaleIn {
  from {
    transform: scale(0.92) translateY(10px);
    opacity: 0;
  }
  to {
    transform: scale(1) translateY(0);
    opacity: 1;
  }
}

/* Hover micro-interactions */
.cky-accordion {
  transition: 
    background 0.2s ease,
    border-color 0.2s ease,
    transform 0.15s ease !important;
}

.cky-accordion:active {
  transform: scale(0.995) !important;
}
```

## 📝 Setup Instructions

1. Go to **CookieYes Dashboard** → **Customize** → **Advanced** → **Custom CSS**
2. Delete any existing CSS
3. Paste the entire CSS above
4. Save changes

## ✨ Key Improvements

- **Aggressive inline style overrides** - Uses multiple selectors to override all inline styles
- **Title completely hidden** - Multiple selectors ensure it's gone
- **Powered by completely removed** - Multiple selectors catch all variations
- **Button styles override** - All inline button colors/styles are overridden
- **Kortix brand colors** - Matches your design system perfectly
- **Premium UX/UI** - Smooth animations, clean design, iOS-style toggles
- **Full dark mode** - Complete support with proper contrast
- **Mobile optimized** - Responsive design for all screen sizes

## 🎨 Font Loading

The CSS loads Roobert from `https://www.kortix.com/fonts/roobert/`
Make sure your fonts are publicly accessible with proper CORS headers.
