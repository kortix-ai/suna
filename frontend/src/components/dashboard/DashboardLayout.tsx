"use client";
import { ReactNode, useState, useEffect, useRef, useCallback } from "react";

import { useTheme } from "next-themes";
import { useToolsPanel } from "@/hooks/use-tools-panel";

// Import our new components
import LeftSidebar from "@/components/dashboard/LeftSidebar";
import Header from "@/components/dashboard/Header";
import MainContent from "@/components/dashboard/MainContent";
import RightSidebar from "@/components/dashboard/RightSidebar";
import FloatingPanel from "@/components/dashboard/FloatingPanel";

interface DashboardLayoutProps {
  children: ReactNode;
  accountId: string;
  userName?: string;
  userEmail?: string;
  rightPanelContent?: ReactNode;
  rightPanelTitle?: string;
}

export default function DashboardLayout({
  children,
  accountId,
  userName,
  userEmail,
  rightPanelContent,
  rightPanelTitle = "Details",
}: DashboardLayoutProps) {
  // Initialize with default values
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(true);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(true);
  const [showRightSidebar, setShowRightSidebar] = useState(false);
  
  // State for draggable panel
  const [position, setPosition] = useState({ x: 20, y: 400 });
  const layoutInitialized = useRef(false);

  // Use our tools panel hook
  const { 
    showPanel, 
    renderToolsPanel,
    toolCalls
  } = useToolsPanel();

  // Use tool panel as the right panel if it's available
  const effectiveRightPanelContent = showPanel ? renderToolsPanel() : rightPanelContent;
  const effectiveRightPanelTitle = showPanel ? `Suna's Computer (${toolCalls.length})` : rightPanelTitle;

  // Update right sidebar visibility based on panel visibility
  useEffect(() => {
    if (showPanel) {
      setShowRightSidebar(true);
      setRightSidebarCollapsed(false);
    } else if (!rightPanelContent) {
      // If the tools panel is hidden and there's no other content, hide the sidebar
      setShowRightSidebar(false);
    }
  }, [showPanel, rightPanelContent]);

  // Set initial showRightSidebar based on rightPanelContent prop
  useEffect(() => {
    // Only set initial visibility, don't override user choices later
    if (!layoutInitialized.current) {
      setShowRightSidebar(!!effectiveRightPanelContent);
    }
  }, [effectiveRightPanelContent]);

  // Load layout state from localStorage on initial render
  useEffect(() => {
    if (typeof window !== "undefined" && !layoutInitialized.current) {
      try {
        const savedLayout = localStorage.getItem("dashboardLayout");
        if (savedLayout) {
          const layout = JSON.parse(savedLayout);
          setLeftSidebarCollapsed(layout.leftSidebarCollapsed);

          if (effectiveRightPanelContent) {
            setRightSidebarCollapsed(layout.rightSidebarCollapsed);
            setShowRightSidebar(layout.showRightSidebar);
          }

          if (
            layout.position &&
            typeof layout.position.x === "number" &&
            typeof layout.position.y === "number"
          ) {
            setPosition(layout.position);
          }

          layoutInitialized.current = true;
        }
      } catch (error) {
        console.error("Error loading layout from localStorage:", error);
      }
    }
  }, [effectiveRightPanelContent]);

  // Save layout state to localStorage whenever relevant state changes
  useEffect(() => {
    if (typeof window !== "undefined" && layoutInitialized.current) {
      try {
        const layoutState = {
          leftSidebarCollapsed,
          rightSidebarCollapsed,
          showRightSidebar,
          position,
        };
        localStorage.setItem("dashboardLayout", JSON.stringify(layoutState));
      } catch (error) {
        console.error("Error saving layout to localStorage:", error);
      }
    }
  }, [leftSidebarCollapsed, rightSidebarCollapsed, showRightSidebar, position]);

  // Toggle left sidebar and ensure right sidebar is collapsed when left is expanded
  const toggleLeftSidebar = useCallback(() => {
    setLeftSidebarCollapsed(!leftSidebarCollapsed);
    if (!leftSidebarCollapsed) {
      // When collapsing left, we don't need to do anything
    } else {
      // When expanding left, collapse the right sidebar
      setRightSidebarCollapsed(true);
    }
  }, [leftSidebarCollapsed, setLeftSidebarCollapsed, setRightSidebarCollapsed]);

  // Toggle right sidebar and ensure left sidebar is collapsed when right is expanded
  const toggleRightSidebar = useCallback(() => {
    setRightSidebarCollapsed(!rightSidebarCollapsed);
    if (!rightSidebarCollapsed) {
      // When collapsing right, we don't need to do anything
    } else {
      // When expanding right, collapse the left sidebar
      setLeftSidebarCollapsed(true);
    }
  }, [
    rightSidebarCollapsed,
    setRightSidebarCollapsed,
    setLeftSidebarCollapsed,
  ]);

  // Toggle right sidebar visibility
  const toggleRightSidebarVisibility = useCallback(() => {
    const newVisibility = !showRightSidebar;
    setShowRightSidebar(newVisibility);
    
    if (newVisibility) {
      // When showing the sidebar, expand it and collapse the left sidebar
      setRightSidebarCollapsed(false);
      setLeftSidebarCollapsed(true);
    } else {
      // When hiding the sidebar, make sure it's fully collapsed
      setRightSidebarCollapsed(true);
    }
  }, [
    showRightSidebar,
    setShowRightSidebar,
    setRightSidebarCollapsed,
    setLeftSidebarCollapsed,
  ]);

  // Update position based on window height (client-side only)
  useEffect(() => {
    if (typeof window !== "undefined") {
      setPosition({ x: 20, y: window.innerHeight - 300 });
    }
  }, []);

  // Keyboard shortcuts for sidebar toggling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check if Command/Ctrl key is pressed
      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const modifierKey = isMac ? e.metaKey : e.ctrlKey;

      if (modifierKey) {
        // Ctrl/Cmd + B for left sidebar
        if (e.key === "b") {
          e.preventDefault();
          toggleLeftSidebar();
        }

        // Ctrl/Cmd + I for right sidebar
        if (e.key === "i") {
          e.preventDefault();
          if (showRightSidebar) {
            toggleRightSidebar();
          } else {
            toggleRightSidebarVisibility();
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    toggleLeftSidebar,
    toggleRightSidebar,
    toggleRightSidebarVisibility,
    showRightSidebar,
  ]);

  // Render floating panel if needed
  const renderFloatingPanelComponent = () => {
    if (showRightSidebar === true && rightSidebarCollapsed === true && effectiveRightPanelContent) {
      return (
        <FloatingPanel
          title={effectiveRightPanelTitle}
          position={position}
          setPosition={setPosition}
          toggleSidebar={toggleRightSidebar}
          toggleVisibility={toggleRightSidebarVisibility}
        />
      );
    }
    return null;
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground relative">
      {/* Left Sidebar */}
      <LeftSidebar
        accountId={accountId}
        userName={userName}
        userEmail={userEmail}
        isCollapsed={leftSidebarCollapsed}
        toggleCollapsed={toggleLeftSidebar}
      />

      {/* Layout container for main content and right panel */}
      <div className="flex flex-1 relative w-full">
        {/* Main Content with separate Header */}
        <div 
          className={`flex flex-col ${
            showRightSidebar && !rightSidebarCollapsed 
              ? "flex-1" 
              : "w-full"
          }`}
        >
          <Header
            userName={userName}
            userEmail={userEmail}
            showRightSidebar={showRightSidebar}
            effectiveRightPanelContent={effectiveRightPanelContent}
            effectiveRightPanelTitle={effectiveRightPanelTitle}
            showPanel={showPanel}
            toggleRightSidebarVisibility={toggleRightSidebarVisibility}
          />
          
          <MainContent
            leftSidebarCollapsed={leftSidebarCollapsed}
            rightSidebarCollapsed={rightSidebarCollapsed}
            showRightSidebar={showRightSidebar}
            showFloatingPanel={showRightSidebar && rightSidebarCollapsed && !!effectiveRightPanelContent}
            renderFloatingPanel={renderFloatingPanelComponent}
          >
            {children}
          </MainContent>
        </div>

        {/* Right Sidebar */}
        {showRightSidebar === true && effectiveRightPanelContent && (
          <RightSidebar
            isCollapsed={rightSidebarCollapsed}
            panelTitle={effectiveRightPanelTitle}
            panelContent={effectiveRightPanelContent}
            toggleSidebar={toggleRightSidebar}
            toggleVisibility={toggleRightSidebarVisibility}
          />
        )}
      </div>
    </div>
  );
}
