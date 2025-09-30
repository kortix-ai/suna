import { AIAgent, Integration } from './types';

// AI Worker definitions - Specialized automation agents
export const allAgents: AIAgent[] = [
  {
    id: 'email-assistant',
    name: 'Email Assistant',
    role: 'Email Management Specialist',
    icon: 'Mail',
    description: 'Automatically sort your email inbox, flag important messages, and draft personalized replies',
    category: 'Productivity',
    tags: ['email', 'automation', 'inbox', 'replies'],
    capabilities: ['Smart inbox sorting', 'Priority flagging', 'Automated replies', 'Email categorization', 'Spam filtering']
  },
  {
    id: 'daily-recap',
    name: 'Daily Recap Agent',
    role: 'Morning Briefing Specialist',
    icon: 'Sun',
    description: 'Send a comprehensive daily recap email every morning to start your day informed',
    category: 'Productivity',
    tags: ['daily', 'recap', 'briefing', 'morning'],
    capabilities: ['Daily summaries', 'Calendar overview', 'Priority tasks', 'Weather & news', 'Team updates']
  },
  {
    id: 'weekly-recap',
    name: 'Weekly Recap Agent',
    role: 'Weekly Summary Specialist',
    icon: 'Calendar',
    description: 'Send a detailed weekly recap email at the start of each week with insights and planning',
    category: 'Productivity',
    tags: ['weekly', 'recap', 'summary', 'planning'],
    capabilities: ['Weekly achievements', 'Goal tracking', 'Upcoming priorities', 'Team performance', 'Strategic insights']
  },
  {
    id: 'lead-generator',
    name: 'Lead Generation Agent',
    role: 'Lead Generation Specialist',
    icon: 'Target',
    description: 'Continuously grow your list of qualified leads through automated prospecting and research',
    category: 'Sales',
    tags: ['leads', 'prospecting', 'generation', 'automation'],
    capabilities: ['Prospect identification', 'Lead qualification', 'Contact enrichment', 'CRM integration', 'Pipeline management']
  },
  {
    id: 'meeting-researcher',
    name: 'Meeting Research Agent',
    role: 'People Research Specialist',
    icon: 'Users',
    description: 'Provide in-depth research reports about people before meetings to help you prepare',
    category: 'Research',
    tags: ['research', 'meetings', 'preparation', 'insights'],
    capabilities: ['Background research', 'Company analysis', 'Social media insights', 'Meeting prep reports', 'Conversation starters']
  },
  {
    id: 'presentation-creator',
    name: 'Presentation Agent',
    role: 'Presentation Creation Specialist',
    icon: 'Monitor',
    description: 'Create professional presentations and slide decks tailored to your content and audience',
    category: 'Content',
    tags: ['presentations', 'slides', 'design', 'content'],
    capabilities: ['Slide creation', 'Content structuring', 'Visual design', 'Template customization', 'Export formats']
  }
];

// Agent categories
export const agentCategories = [
  { id: 'all', name: 'All', description: 'View all available AI workers' },
  { id: 'Productivity', name: 'Productivity', description: 'Email, scheduling, and daily automation' },
  { id: 'Sales', name: 'Sales', description: 'Lead generation and sales automation' },
  { id: 'Research', name: 'Research', description: 'Information gathering and analysis' },
  { id: 'Content', name: 'Content', description: 'Content creation and presentation tools' }
];

// Integration definitions by AI worker
export const integrationsByAgent: Record<string, Integration[]> = {
  'email-assistant': [
    { name: 'Gmail', icon: 'Mail', description: 'Connect to Gmail for email management', category: 'email' },
    { name: 'Outlook', icon: 'Mail', description: 'Microsoft Outlook integration', category: 'email' },
    { name: 'Slack', icon: 'MessageSquare', description: 'Team notifications and updates', category: 'communication' },
    { name: 'Zapier', icon: 'Zap', description: 'Automate email workflows', category: 'automation' }
  ],
  'daily-recap': [
    { name: 'Google Calendar', icon: 'Calendar', description: 'Calendar events and meetings', category: 'scheduling' },
    { name: 'Todoist', icon: 'CheckSquare', description: 'Task and project management', category: 'productivity' },
    { name: 'Weather API', icon: 'Cloud', description: 'Weather information', category: 'data' },
    { name: 'News API', icon: 'Newspaper', description: 'Latest news updates', category: 'data' }
  ],
  'weekly-recap': [
    { name: 'Google Analytics', icon: 'BarChart3', description: 'Website performance metrics', category: 'analytics' },
    { name: 'Asana', icon: 'Clipboard', description: 'Project progress tracking', category: 'project-management' },
    { name: 'Slack', icon: 'MessageSquare', description: 'Team activity summaries', category: 'communication' },
    { name: 'HubSpot', icon: 'Building', description: 'Sales and marketing metrics', category: 'crm' }
  ],
  'lead-generator': [
    { name: 'LinkedIn', icon: 'Briefcase', description: 'Professional networking and prospecting', category: 'social' },
    { name: 'Salesforce', icon: 'Cloud', description: 'CRM integration for lead management', category: 'crm' },
    { name: 'Apollo', icon: 'Target', description: 'Lead database and enrichment', category: 'data' },
    { name: 'ZoomInfo', icon: 'Search', description: 'Contact and company information', category: 'data' }
  ],
  'meeting-researcher': [
    { name: 'LinkedIn', icon: 'Briefcase', description: 'Professional background research', category: 'social' },
    { name: 'Crunchbase', icon: 'Building', description: 'Company information and funding', category: 'data' },
    { name: 'Google Search', icon: 'Search', description: 'General information gathering', category: 'search' },
    { name: 'Twitter', icon: 'MessageSquare', description: 'Social media insights', category: 'social' }
  ],
  'presentation-creator': [
    { name: 'PowerPoint', icon: 'Monitor', description: 'Microsoft PowerPoint integration', category: 'presentation' },
    { name: 'Google Slides', icon: 'Monitor', description: 'Google Slides creation', category: 'presentation' },
    { name: 'Canva', icon: 'Palette', description: 'Design templates and graphics', category: 'design' },
    { name: 'Unsplash', icon: 'Image', description: 'High-quality stock photos', category: 'media' }
  ]
};

