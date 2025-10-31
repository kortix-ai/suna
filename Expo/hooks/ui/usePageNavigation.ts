import * as React from 'react';
import * as Haptics from 'expo-haptics';

/**
 * usePageNavigation Hook (Refactored for Drawer)
 * 
 * Manages navigation between drawer and main content
 * 
 * Structure:
 * - Drawer: Menu (left side)
 * - Main: Home (center/default)
 * 
 * The drawer supports swipe gestures and full-page appearance
 * The drawer is controlled via open/close state, not refs
 * 
 * Features:
 * - Haptic feedback on drawer open/close
 * - Swipe gesture support
 */
export function usePageNavigation() {
  const [isDrawerOpen, setIsDrawerOpen] = React.useState(false);
  
  /**
   * Handle drawer open - called by Drawer component's onOpen callback
   * This is the single source of truth for opening the drawer
   */
  const handleDrawerOpen = React.useCallback(() => {
    console.log('📄 Drawer opened');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsDrawerOpen(true);
  }, []);
  
  /**
   * Handle drawer close - called by Drawer component's onClose callback
   * This is the single source of truth for closing the drawer
   */
  const handleDrawerClose = React.useCallback(() => {
    console.log('📄 Drawer closed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsDrawerOpen(false);
  }, []);
  
  /**
   * Programmatically open the drawer (e.g., via menu button)
   * Just sets state - the Drawer component's onOpen will handle logging
   */
  const openDrawer = React.useCallback(() => {
    setIsDrawerOpen(true);
  }, []);
  
  /**
   * Programmatically close the drawer (e.g., via close button)
   * Just sets state - the Drawer component's onClose will handle logging
   */
  const closeDrawer = React.useCallback(() => {
    setIsDrawerOpen(false);
  }, []);
  
  /**
   * Toggle drawer state
   */
  const toggleDrawer = React.useCallback(() => {
    setIsDrawerOpen((prev) => !prev);
  }, []);
  
  // Legacy compatibility - goToMenu opens drawer, goToHome closes it
  const goToMenu = openDrawer;
  const goToHome = closeDrawer;
  
  return {
    isDrawerOpen,
    openDrawer,
    closeDrawer,
    toggleDrawer,
    handleDrawerOpen,
    handleDrawerClose,
    goToMenu,
    goToHome,
    isOnMenu: isDrawerOpen,
    isOnHome: !isDrawerOpen,
  };
}

