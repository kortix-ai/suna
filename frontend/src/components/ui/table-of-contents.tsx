'use client';

import { useEffect, useState, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Menu } from 'lucide-react';

interface TableOfContentsProps {
  className?: string;
}

interface HeadingItem {
  id: string;
  text: string;
  level: number;
}

export function TableOfContents({ className }: TableOfContentsProps) {
  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const pathname = usePathname();

  const getHeadings = useCallback(() => {
    const headingElements = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const headingItems: HeadingItem[] = [];

    headingElements.forEach((heading) => {
      if (heading.id) {
        headingItems.push({
          id: heading.id,
          text: heading.textContent || '',
          level: parseInt(heading.tagName.charAt(1)),
        });
      }
    });

    return headingItems;
  }, []);

  useEffect(() => {
    const updateHeadings = () => {
      const newHeadings = getHeadings();
      setHeadings(newHeadings);
      if (newHeadings.length > 0) {
        setActiveId(newHeadings[0].id);
      } else {
        setActiveId('');
      }
    };
    
    updateHeadings();
    const timeout = setTimeout(updateHeadings, 200);
    
    return () => clearTimeout(timeout);
  }, [getHeadings, pathname]);

  useEffect(() => {
    if (headings.length === 0) return;
    const handleScroll = () => {
      const scrollY = window.scrollY;
      const windowHeight = window.innerHeight;
      const offset = Math.min(windowHeight * 0.2, 100);
      let activeHeading = headings[0];
      for (let i = headings.length - 1; i >= 0; i--) {
        const heading = headings[i];
        const element = document.getElementById(heading.id);
        
        if (element) {
          const rect = element.getBoundingClientRect();
          const elementTop = scrollY + rect.top;
          if (elementTop <= scrollY + offset) {
            activeHeading = heading;
            break;
          }
        }
      }
      setActiveId(activeHeading.id);
    };
    handleScroll();
    let rafId: number;
    const throttledScroll = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(handleScroll);
    };

    window.addEventListener('scroll', throttledScroll, { passive: true });
    window.addEventListener('resize', handleScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', throttledScroll);
      window.removeEventListener('resize', handleScroll);
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [headings, pathname]);

  const scrollToSection = (id: string) => {
    const element = document.getElementById(id);
    if (element) {
      const windowHeight = window.innerHeight;
      const offset = Math.min(windowHeight * 0.15, 80);
      
      const elementTop = element.getBoundingClientRect().top + window.scrollY;
      const targetPosition = elementTop - offset;
      
      window.scrollTo({
        top: targetPosition,
        behavior: 'smooth'
      });
      setActiveId(id);
    }
  };

  if (headings.length === 0) return null;

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center gap-2 mb-4">
        <Menu className="w-4 h-4" />
        <h4 className="font-semibold text-foreground">On this page</h4>
      </div>
      
      <nav className="space-y-1">
        {headings.map((heading) => (
          <button
            key={heading.id}
            onClick={() => scrollToSection(heading.id)}
            className={cn(
              'mb-4 block w-full text-left text-sm transition-all duration-200 py-0.5 px-3 hover:text-accent-foreground',
              activeId === heading.id
                ? 'text-primary font-semibold border-l-2 border-primary'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {heading.text}
          </button>
        ))}
      </nav>
    </div>
  );
} 