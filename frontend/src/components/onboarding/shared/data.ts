import { AIAgent, Integration } from './types';

// AI Agent definitions
export const allAgents: AIAgent[] = [
  {
    id: 'maya',
    name: 'Maya',
    role: 'Content Creator',
    icon: '✍️',
    description: 'Create engaging content, blog posts, social media, and marketing materials',
    category: 'Growth',
    tags: ['content', 'writing', 'marketing', 'social media'],
    capabilities: ['Blog writing', 'Social media content', 'Email campaigns', 'SEO content']
  },
  {
    id: 'hunter',
    name: 'Hunter',
    role: 'Talent Recruiter',
    icon: '🎯',
    description: 'Find, screen, and recruit top talent for your team',
    category: 'Operations',
    tags: ['recruitment', 'hr', 'talent', 'hiring'],
    capabilities: ['Candidate sourcing', 'Resume screening', 'Interview scheduling', 'Talent pipeline']
  },
  {
    id: 'nova',
    name: 'Nova',
    role: 'SEO Specialist',
    icon: '🚀',
    description: 'Optimize your website and content for search engines',
    category: 'Growth',
    tags: ['seo', 'optimization', 'search', 'analytics'],
    capabilities: ['Keyword research', 'On-page SEO', 'Technical SEO', 'Performance tracking']
  },
  {
    id: 'sage',
    name: 'Sage',
    role: 'Business Intelligence Analyst',
    icon: '📊',
    description: 'Analyze data and provide actionable business insights',
    category: 'Analytics',
    tags: ['analytics', 'data', 'insights', 'reporting'],
    capabilities: ['Data analysis', 'Report generation', 'KPI tracking', 'Business intelligence']
  },
  {
    id: 'alex',
    name: 'Alex',
    role: 'Customer Success Manager',
    icon: '🤝',
    description: 'Manage customer relationships and ensure satisfaction',
    category: 'Support',
    tags: ['customer success', 'support', 'retention', 'satisfaction'],
    capabilities: ['Customer onboarding', 'Issue resolution', 'Retention strategies', 'Feedback analysis']
  },
  {
    id: 'byte',
    name: 'Byte',
    role: 'Software Engineer',
    icon: '💻',
    description: 'Develop and maintain software applications and systems',
    category: 'Product',
    tags: ['development', 'coding', 'software', 'engineering'],
    capabilities: ['Code development', 'System architecture', 'Code review', 'Technical documentation']
  },
  {
    id: 'pixel',
    name: 'Pixel',
    role: 'UI/UX Designer',
    icon: '🎨',
    description: 'Design beautiful and intuitive user interfaces',
    category: 'Product',
    tags: ['design', 'ui', 'ux', 'interface'],
    capabilities: ['UI design', 'UX research', 'Prototyping', 'Design systems']
  },
  {
    id: 'echo',
    name: 'Echo',
    role: 'Sales Representative',
    icon: '💼',
    description: 'Drive sales and build relationships with prospects',
    category: 'Growth',
    tags: ['sales', 'prospects', 'leads', 'revenue'],
    capabilities: ['Lead qualification', 'Sales calls', 'Pipeline management', 'Deal closing']
  }
];

// Agent categories
export const agentCategories = [
  { id: 'all', name: 'All', description: 'View all available agents' },
  { id: 'Leadership', name: 'Leadership', description: 'Strategic and executive roles' },
  { id: 'Growth', name: 'Growth', description: 'Marketing, sales, and business development' },
  { id: 'Product', name: 'Product', description: 'Development, design, and product management' },
  { id: 'Operations', name: 'Operations', description: 'HR, operations, and process management' },
  { id: 'Analytics', name: 'Analytics', description: 'Data analysis and business intelligence' },
  { id: 'Support', name: 'Support', description: 'Customer success and support' }
];

// Integration definitions by agent
export const integrationsByAgent: Record<string, Integration[]> = {
  maya: [
    { name: 'Google Docs', icon: '📄', description: 'Write and collaborate on documents', category: 'productivity' },
    { name: 'WordPress', icon: '📝', description: 'Publish content directly to WordPress', category: 'publishing' },
    { name: 'Mailchimp', icon: '📧', description: 'Create email marketing campaigns', category: 'email' },
    { name: 'Buffer', icon: '📱', description: 'Schedule social media posts', category: 'social' },
    { name: 'Grammarly', icon: '✍️', description: 'AI-powered writing assistant', category: 'productivity' }
  ],
  hunter: [
    { name: 'LinkedIn', icon: '💼', description: 'Source and contact candidates', category: 'recruiting' },
    { name: 'Indeed', icon: '🔍', description: 'Post jobs and search candidates', category: 'recruiting' },
    { name: 'Calendly', icon: '📅', description: 'Schedule interviews automatically', category: 'scheduling' },
    { name: 'Greenhouse', icon: '🌱', description: 'Applicant tracking system', category: 'ats' },
    { name: 'Slack', icon: '💬', description: 'Team communication and updates', category: 'communication' }
  ],
  nova: [
    { name: 'Google Analytics', icon: '📊', description: 'Website traffic analysis', category: 'analytics' },
    { name: 'Search Console', icon: '🔍', description: 'Monitor search performance', category: 'seo' },
    { name: 'SEMrush', icon: '📈', description: 'Keyword research and tracking', category: 'seo' },
    { name: 'Ahrefs', icon: '🔗', description: 'Backlink analysis and monitoring', category: 'seo' }
  ],
  sage: [
    { name: 'Google Analytics', icon: '📊', description: 'Web analytics and insights', category: 'analytics' },
    { name: 'Tableau', icon: '📈', description: 'Data visualization platform', category: 'visualization' },
    { name: 'Power BI', icon: '⚡', description: 'Business intelligence dashboard', category: 'bi' },
    { name: 'Excel', icon: '📋', description: 'Spreadsheet analysis and reporting', category: 'productivity' }
  ],
  alex: [
    { name: 'Intercom', icon: '💬', description: 'Customer messaging platform', category: 'support' },
    { name: 'Zendesk', icon: '🎫', description: 'Customer support ticketing', category: 'support' },
    { name: 'HubSpot', icon: '🏢', description: 'CRM and customer management', category: 'crm' },
    { name: 'Calendly', icon: '📅', description: 'Meeting scheduling', category: 'scheduling' }
  ],
  byte: [
    { name: 'GitHub', icon: '🐙', description: 'Code repository and collaboration', category: 'development' },
    { name: 'VS Code', icon: '💻', description: 'Code editor and development', category: 'development' },
    { name: 'Jira', icon: '📋', description: 'Project and issue tracking', category: 'project-management' },
    { name: 'Docker', icon: '🐳', description: 'Containerization and deployment', category: 'devops' }
  ],
  pixel: [
    { name: 'Figma', icon: '🎨', description: 'Design and prototyping tool', category: 'design' },
    { name: 'Adobe XD', icon: '🎭', description: 'UI/UX design platform', category: 'design' },
    { name: 'Sketch', icon: '✏️', description: 'Vector graphics and design', category: 'design' },
    { name: 'Notion', icon: '📝', description: 'Documentation and collaboration', category: 'productivity' }
  ],
  echo: [
    { name: 'Salesforce', icon: '☁️', description: 'CRM and sales management', category: 'crm' },
    { name: 'HubSpot', icon: '🏢', description: 'Sales pipeline and automation', category: 'crm' },
    { name: 'Calendly', icon: '📅', description: 'Meeting and demo scheduling', category: 'scheduling' },
    { name: 'Zoom', icon: '📹', description: 'Video calls and presentations', category: 'communication' }
  ]
};

