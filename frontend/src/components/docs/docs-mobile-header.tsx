'use client';

import React from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useTheme } from 'next-themes';
import { Menu, X } from 'lucide-react';
import { 
  FileText, 
  Rocket, 
  Settings, 
  Code, 
  Zap,
  BookOpen,
  Users,
  Shield,
  Database,
  Sun,
  Moon
} from 'lucide-react';

const navigationItems = [
  {
    title: 'Getting Started',
    items: [
      { title: 'Introduction', href: '#introduction', icon: BookOpen },
      { title: 'Quick Start', href: '#quick-start', icon: Rocket },
      { title: 'Installation', href: '#installation', icon: Settings },
    ]
  },
  {
    title: 'Guides',
    items: [
      { title: 'Building Agents', href: '#building-agents', icon: Code },
      { title: 'Automation', href: '#automation', icon: Zap },
      { title: 'Workflows', href: '#workflows', icon: FileText },
    ]
  },
  {
    title: 'Advanced',
    items: [
      { title: 'API Reference', href: '#api-reference', icon: Database },
      { title: 'Authentication', href: '#authentication', icon: Shield },
      { title: 'Community', href: '#community', icon: Users },
    ]
  }
];

export const DocsMobileHeader = () => {
  const { theme, setTheme } = useTheme();

  return (
    <div className="lg:hidden sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border/40">
      <div className="flex items-center justify-between p-4">
        <div>
          <h1 className="text-xl font-bold bg-gradient-to-r from-primary to-primary/80 bg-clip-text text-transparent">
            Suna Docs
          </h1>
        </div>
        
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            className="h-8 w-8 p-0 bg-muted/40 hover:bg-accent/60 backdrop-blur-sm"
          >
            <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
            <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            <span className="sr-only">Toggle theme</span>
          </Button>
          
          <Sheet>
          <SheetTrigger asChild>
            <Button 
              variant="ghost" 
              size="sm"
              className="bg-muted/60 backdrop-blur-sm"
            >
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent 
            side="left" 
            className="w-80 p-0 bg-background/90 backdrop-blur-xl border-border/40"
          >
            <div className="p-6">
              {/* Logo/Title */}
              <div className="mb-8">
                <h1 className="text-2xl font-bold bg-gradient-to-r from-primary to-primary/80 bg-clip-text text-transparent">
                  Suna Docs
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                  Build powerful AI agents
                </p>
              </div>

              {/* Search placeholder */}
              <div className="mb-6">
                <Button 
                  variant="outline" 
                  className="w-full justify-start text-muted-foreground bg-muted/50 backdrop-blur-sm border-border/40"
                >
                  <FileText className="mr-2 h-4 w-4" />
                  Search documentation...
                </Button>
              </div>

              <ScrollArea className="h-[calc(100vh-240px)]">
                <nav className="space-y-6">
                  {navigationItems.map((section, index) => (
                    <div key={section.title}>
                      <h3 className="font-medium text-sm text-muted-foreground uppercase tracking-wider mb-3">
                        {section.title}
                      </h3>
                      <div className="space-y-1">
                        {section.items.map((item) => (
                          <Button
                            key={item.title}
                            variant="ghost"
                            className="w-full justify-start h-auto p-3 hover:bg-accent/60 backdrop-blur-sm"
                            asChild
                          >
                            <a href={item.href}>
                              <item.icon className="mr-3 h-4 w-4" />
                              <span className="text-sm">{item.title}</span>
                            </a>
                          </Button>
                        ))}
                      </div>
                      {index < navigationItems.length - 1 && (
                        <Separator className="mt-4 bg-border/40" />
                      )}
                    </div>
                  ))}
                </nav>
              </ScrollArea>

              {/* Theme toggle and Version */}
              <div className="mt-6 pt-4 border-t border-border/40">
                <div className="flex items-center justify-between">
                                      <Badge variant="secondary" className="bg-muted/60 backdrop-blur-sm">
                    v1.0.0
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
                                         className="h-8 w-8 p-0 bg-muted/40 hover:bg-accent/60 backdrop-blur-sm"
                  >
                    <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
                    <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
                    <span className="sr-only">Toggle theme</span>
                  </Button>
                </div>
              </div>
            </div>
          </SheetContent>
        </Sheet>
        </div>
      </div>
    </div>
  );
}; 