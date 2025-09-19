import { 
  BookOpen, 
  Rocket, 
  Settings, 
  Code, 
  Zap, 
  FileText,
  Users,
  Shield,
  Database,
  Layers,
  Palette,
  MessageSquare,
  Image,
  Table,
  Map
} from 'lucide-react';

import type { DocsNavigationSection } from '@/components/ui/docs-sidebar';
import type { DocsTableColumn } from '@/components/ui/docs-index';

export const sampleNavigation: DocsNavigationSection[] = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    items: [
      {
        id: 'introduction',
        title: 'What is Kortix?',
        href: '#introduction',
        icon: BookOpen,
        isActive: true
      },
      {
        id: 'quick-start',
        title: 'Quick Start',
        href: '#quick-start',
        icon: Rocket,
        badge: 'Recommended'
      },
      {
        id: 'setup-wizard',
        title: 'Setup Wizard',
        href: '#setup-wizard',
        icon: Zap
      }
    ]
  },
  {
    id: 'self-hosting',
    title: 'Self-Hosting Guide',
    items: [
      {
        id: 'overview',
        title: 'Overview',
        href: '#self-hosting-overview',
        icon: Layers
      },
      {
        id: 'prerequisites',
        title: 'Prerequisites',
        href: '#prerequisites',
        icon: Settings,
        children: [
          {
            id: 'supabase-setup',
            title: 'Supabase Project',
            href: '#supabase-setup'
          },
          {
            id: 'api-keys',
            title: 'API Keys',
            href: '#api-keys'
          },
          {
            id: 'software',
            title: 'Required Software',
            href: '#required-software'
          }
        ]
      },
      {
        id: 'installation',
        title: 'Installation',
        href: '#installation',
        icon: Code,
        children: [
          {
            id: 'docker-setup',
            title: 'Docker Setup',
            href: '#docker-setup'
          },
          {
            id: 'manual-setup',
            title: 'Manual Setup',
            href: '#manual-setup'
          }
        ]
      },
      {
        id: 'configuration',
        title: 'Configuration',
        href: '#configuration',
        icon: Settings,
        children: [
          {
            id: 'backend-env',
            title: 'Backend Environment',
            href: '#backend-env'
          },
          {
            id: 'frontend-env',
            title: 'Frontend Environment',
            href: '#frontend-env'
          }
        ]
      },
      {
        id: 'troubleshooting',
        title: 'Troubleshooting',
        href: '#troubleshooting',
        icon: Shield
      }
    ]
  },
  {
    id: 'platform',
    title: 'Platform',
    items: [
      {
        id: 'architecture',
        title: 'Architecture',
        href: '#architecture',
        icon: Database
      },
      {
        id: 'agent-examples',
        title: 'Agent Examples',
        href: '#agent-examples',
        icon: Users,
        badge: 'Popular'
      },
      {
        id: 'contributing',
        title: 'Contributing',
        href: '#contributing',
        icon: MessageSquare
      }
    ]
  }
];

export const sampleBreadcrumbs = [
  { title: 'Documentation', onClick: () => console.log('Navigate to docs') },
  { title: 'Kortix Platform Guide' }
];

export const kortixFeatures = [
  {
    title: 'Browser Automation',
    description: 'Navigate websites, extract data, fill forms, automate web workflows',
    icon: Code
  },
  {
    title: 'File Management',
    description: 'Create, edit, and organize documents, spreadsheets, presentations, code',
    icon: FileText
  },
  {
    title: 'Web Intelligence',
    description: 'Crawling, search capabilities, data extraction and synthesis',
    icon: Zap
  },
  {
    title: 'System Operations',
    description: 'Command-line execution, system administration, DevOps tasks',
    icon: Settings
  },
  {
    title: 'API Integrations',
    description: 'Connect with external services and automate cross-platform workflows',
    icon: Database
  },
  {
    title: 'Agent Builder',
    description: 'Visual tools to configure, customize, and deploy agents',
    icon: Palette
  }
];

export const sampleTableData = [
  {
    component: 'Button',
    status: 'Stable',
    version: '1.0.0',
    description: 'Interactive button component with variants'
  },
  {
    component: 'Card',
    status: 'Stable',
    version: '1.2.0',
    description: 'Container component for grouping content'
  },
  {
    component: 'Modal',
    status: 'Beta',
    version: '0.9.0',
    description: 'Overlay component for focused interactions'
  },
  {
    component: 'Table',
    status: 'Stable',
    version: '1.1.0',
    description: 'Data display component with sorting'
  }
];

export const sampleTableColumns: DocsTableColumn[] = [
  {
    key: 'component',
    title: 'Component',
    width: '200px'
  },
  {
    key: 'status',
    title: 'Status',
    width: '120px'
  },
  {
    key: 'version',
    title: 'Version',
    width: '100px',
    align: 'center'
  },
  {
    key: 'description',
    title: 'Description'
  }
]; 