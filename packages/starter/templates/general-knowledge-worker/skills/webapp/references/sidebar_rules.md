# Shadcn Sidebar

## General Rules

- **Always** use the Shadcn sidebar located at `@/components/ui/sidebar` if your application calls for a sidebar.
- **Never** reimplement your own unless the user explicitly asks you to not use the Shadcn sidebar.
- **Never** set the width on a `<Sidebar />` component. Instead, set CSS style properties on `SidebarProvider`:

```tsx
// Bad
<Sidebar className="w-60">

// Good
const style = {
  "--sidebar-width": "20rem",      // default is 16rem
  "--sidebar-width-icon": "4rem",  // default is 3rem
};

<SidebarProvider style={style as React.CSSProperties}>
```

- You **must** supply `w-full` to the element that is the immediate child of `SidebarProvider`:

```tsx
// Good
<SidebarProvider style={style as React.CSSProperties}>
  <div className="flex h-screen w-full">
  ...

// Bad - missing w-full on child
<SidebarProvider style={style as React.CSSProperties}>
  <div className="flex h-screen">
  ...
```

## Basic Setup

### 1. Add Provider and Trigger

Add `SidebarProvider` and `SidebarTrigger` at the root of your application:

```tsx
// client/src/App.tsx
import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";

function Router() {
  return (
    <Switch>
      {/* <Route path="/" component={Home}/> */}
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  const style = {
    "--sidebar-width": "20rem",
    "--sidebar-width-icon": "4rem",
  };

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SidebarProvider style={style as React.CSSProperties}>
          <div className="flex h-screen w-full">
            <AppSidebar />
            <div className="flex flex-col flex-1">
              <header className="flex items-center justify-between p-2 border-b">
                <SidebarTrigger data-testid="button-sidebar-toggle" />
                <ThemeToggle />
              </header>
              <main className="flex-1 overflow-hidden">
                <Router />
              </main>
            </div>
          </div>
        </SidebarProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
```

### 2. Create Sidebar Component

Create a new sidebar component at `components/app-sidebar.tsx`:

```tsx
// components/app-sidebar.tsx
import { Sidebar, SidebarContent } from "@/components/ui/sidebar";

export function AppSidebar() {
  return (
    <Sidebar>
      <SidebarContent />
    </Sidebar>
  );
}
```

### 3. Add Menu Items

Add a `SidebarMenu` inside a `SidebarGroup`:

```tsx
// components/app-sidebar.tsx
import { Calendar, Home, Inbox, Search, Settings } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const items = [
  { title: "Home", url: "#", icon: Home },
  { title: "Inbox", url: "#", icon: Inbox },
  { title: "Calendar", url: "#", icon: Calendar },
  { title: "Search", url: "#", icon: Search },
  { title: "Settings", url: "#", icon: Settings },
];

export function AppSidebar() {
  return (
    <Sidebar>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Application</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild>
                    <a href={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
```
