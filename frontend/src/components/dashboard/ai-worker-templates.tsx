'use client';

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import {
  Target,
  Users,
  Calendar,
  MessageSquare,
  TrendingUp,
  Mail,
  Phone,
  FileText,
  BarChart3,
  Briefcase,
  HeadphonesIcon,
  Zap,
  Search,
  DollarSign,
  ShoppingCart,
  Package,
  Clock,
  Bell,
  Star,
  Shield,
  Code2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

interface AIWorkerTemplatesProps {
  onSelectWorker: (worker: WorkerTemplate) => void;
  isMobile?: boolean;
}

type WorkerCategory = 'sales' | 'meetings' | 'popular' | 'productivity' | 'support' | 'marketing';

interface WorkerTemplate {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  category: WorkerCategory;
  featured?: boolean;
}

const workerTemplates: WorkerTemplate[] = [
  // Sales
  {
    id: 'lead-generator',
    name: 'Lead Generator',
    description: 'Find and organize sales leads instantly',
    icon: <Target className="w-5 h-5" />,
    category: 'sales',
    featured: true,
  },
  {
    id: 'lead-outreacher',
    name: 'Lead Outreacher',
    description: 'Automate outreach and lead engagement',
    icon: <Mail className="w-5 h-5" />,
    category: 'sales',
  },
  {
    id: 'call-agent',
    name: 'Outbound Phone Call Agent',
    description: 'Make calls and qualify leads instantly',
    icon: <Phone className="w-5 h-5" />,
    category: 'sales',
  },
  {
    id: 'meeting-recorder',
    name: 'Sales Meeting Recorder',
    description: 'Take notes during sales calls and send follow-ups automatically',
    icon: <FileText className="w-5 h-5" />,
    category: 'sales',
  },
  
  // Meetings
  {
    id: 'meeting-scheduler',
    name: 'Meeting Scheduler',
    description: 'Schedule your meetings, and find a time that works for everyone',
    icon: <Calendar className="w-5 h-5" />,
    category: 'meetings',
    featured: true,
  },
  {
    id: 'meeting-notetaker',
    name: 'Meeting Notetaker',
    description: 'Capture meeting details, sends follow-ups, and answers questions',
    icon: <FileText className="w-5 h-5" />,
    category: 'meetings',
  },
  {
    id: 'meeting-prep',
    name: 'Meeting Prep Assistant',
    description: 'Get ready for meetings in minutes',
    icon: <Briefcase className="w-5 h-5" />,
    category: 'meetings',
  },
  {
    id: 'meeting-coach',
    name: 'Meeting Coach',
    description: 'Enhances your meeting skills',
    icon: <Users className="w-5 h-5" />,
    category: 'meetings',
  },
  
  // Most Popular
  {
    id: 'recruiting-agent',
    name: 'Recruiting Agent',
    description: 'Find and organize sales leads instantly',
    icon: <Users className="w-5 h-5" />,
    category: 'popular',
    featured: true,
  },
  {
    id: 'customer-support',
    name: 'Customer Support Email',
    description: 'Handle customer questions via email',
    icon: <MessageSquare className="w-5 h-5" />,
    category: 'popular',
  },
  {
    id: 'brand-monitor',
    name: 'Brand Monitor',
    description: 'Track your brand\'s digital footprint',
    icon: <TrendingUp className="w-5 h-5" />,
    category: 'popular',
  },
  {
    id: 'request-reviewer',
    name: 'Pull Request Reviewer',
    description: 'Automate code reviews according to any guide',
    icon: <Code2 className="w-5 h-5" />,
    category: 'popular',
  },
  
  // Productivity
  {
    id: 'email-responder',
    name: 'Email Responder',
    description: 'Automate email tasks',
    icon: <Mail className="w-5 h-5" />,
    category: 'productivity',
    featured: true,
  },
  {
    id: 'email-triager',
    name: 'Email Triager',
    description: 'Smart email triage, done for you',
    icon: <Zap className="w-5 h-5" />,
    category: 'productivity',
  },
  {
    id: 'website-summarizer',
    name: 'Website Summarizer',
    description: 'Quick website summaries in seconds',
    icon: <Search className="w-5 h-5" />,
    category: 'productivity',
  },
  {
    id: 'follow-up-reminder',
    name: 'Follow-up Reminder',
    description: 'Never forget to follow up on emails',
    icon: <Bell className="w-5 h-5" />,
    category: 'productivity',
  },
  
  // Support
  {
    id: 'ticket-responder',
    name: 'Ticket Responder',
    description: 'Automate support ticket responses',
    icon: <HeadphonesIcon className="w-5 h-5" />,
    category: 'support',
  },
  {
    id: 'faq-assistant',
    name: 'FAQ Assistant',
    description: 'Answer common questions instantly',
    icon: <MessageSquare className="w-5 h-5" />,
    category: 'support',
  },
  {
    id: 'escalation-manager',
    name: 'Escalation Manager',
    description: 'Route urgent issues to the right team',
    icon: <Shield className="w-5 h-5" />,
    category: 'support',
  },
  
  // Marketing
  {
    id: 'content-scheduler',
    name: 'Content Scheduler',
    description: 'Plan and schedule content across channels',
    icon: <Calendar className="w-5 h-5" />,
    category: 'marketing',
  },
  {
    id: 'social-monitor',
    name: 'Social Media Monitor',
    description: 'Track mentions and engagement',
    icon: <TrendingUp className="w-5 h-5" />,
    category: 'marketing',
  },
  {
    id: 'campaign-analyzer',
    name: 'Campaign Analyzer',
    description: 'Analyze marketing campaign performance',
    icon: <BarChart3 className="w-5 h-5" />,
    category: 'marketing',
  },
];

const getCategoryCount = (categoryId: WorkerCategory): number => {
  return workerTemplates.filter(w => w.category === categoryId).length;
};

const categories = [
  { id: 'sales' as const, label: 'Sales' },
  { id: 'meetings' as const, label: 'Meetings' },
  { id: 'popular' as const, label: 'Most popular' },
  { id: 'productivity' as const, label: 'Productivity' },
  { id: 'support' as const, label: 'Support' },
  { id: 'marketing' as const, label: 'Marketing' },
];

export function AIWorkerTemplates({ onSelectWorker, isMobile = false }: AIWorkerTemplatesProps) {
  const [selectedCategory, setSelectedCategory] = useState<WorkerCategory>('sales');
  
  const filteredWorkers = workerTemplates.filter(w => w.category === selectedCategory);
  const featuredWorker = filteredWorkers.find(w => w.featured);

  return (
    <div className="w-full space-y-6">
      {/* Category Tabs with See all */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-hide flex-1">
          {categories.map((category) => (
            <Button
              key={category.id}
              variant="ghost"
              size="sm"
              onClick={() => setSelectedCategory(category.id)}
              className={cn(
                "shrink-0 transition-all duration-200 rounded-lg px-4 h-9",
                selectedCategory === category.id
                  ? "bg-primary/10 text-primary hover:bg-primary/15"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
            >
              {category.label}
            </Button>
          ))}
        </div>
        <button className="text-sm text-primary hover:text-primary/80 transition-colors shrink-0 font-medium">
          See all
        </button>
      </div>

      {/* Featured Worker - Large Card */}
      {featuredWorker && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <Card
            className="p-6 cursor-pointer hover:bg-primary/5 transition-all duration-200 border-border rounded-xl bg-gradient-to-br from-primary/5 to-transparent"
            onClick={() => onSelectWorker(featuredWorker)}
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary shrink-0">
                {featuredWorker.icon}
              </div>
              <div className="flex-1 space-y-1">
                <h3 className="font-semibold text-base text-foreground">
                  {featuredWorker.name}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {featuredWorker.description}
                </p>
              </div>
            </div>
          </Card>
        </motion.div>
      )}

      {/* Worker Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {filteredWorkers
          .filter(w => !w.featured)
          .map((worker, index) => (
            <motion.div
              key={worker.id}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{
                duration: 0.2,
                delay: index * 0.05,
                ease: "easeOut"
              }}
            >
              <Card
                className="p-4 cursor-pointer hover:bg-primary/5 transition-all duration-200 group border-border rounded-xl"
                onClick={() => onSelectWorker(worker)}
              >
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg bg-muted/50 flex items-center justify-center text-muted-foreground group-hover:text-primary group-hover:bg-primary/10 transition-all duration-200 shrink-0">
                    {worker.icon}
                  </div>
                  <div className="flex-1 space-y-0.5">
                    <h4 className="font-medium text-sm text-foreground group-hover:text-primary transition-colors duration-200">
                      {worker.name}
                    </h4>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {worker.description}
                    </p>
                  </div>
                </div>
              </Card>
            </motion.div>
          ))}
      </div>
    </div>
  );
}

