/**
 * Mode Options Configuration
 * 
 * Defines the templates/options available for each quick action mode
 */

interface ModeOption {
  id: string;
  label: string;
  description: string;
  prompt?: string;
}

export const MODE_OPTIONS: Record<string, ModeOption[]> = {
  slides: [
    {
      id: 'pitch-deck',
      label: 'Pitch Deck',
      description: 'Create a compelling presentation for investors and stakeholders',
      prompt: 'Create a professional pitch deck about',
    },
    {
      id: 'business-presentation',
      label: 'Business Presentation',
      description: 'Professional slides for meetings and reports',
      prompt: 'Create a business presentation about',
    },
    {
      id: 'educational-slides',
      label: 'Educational Slides',
      description: 'Engaging slides for teaching and learning',
      prompt: 'Create educational slides about',
    },
    {
      id: 'product-demo',
      label: 'Product Demo',
      description: 'Showcase your product features and benefits',
      prompt: 'Create a product demo presentation for',
    },
  ],
  research: [
    {
      id: 'deep-research',
      label: 'Deep Research',
      description: 'Comprehensive analysis with multiple sources',
      prompt: 'Research in-depth about',
    },
    {
      id: 'quick-summary',
      label: 'Quick Summary',
      description: 'Fast overview of key points and insights',
      prompt: 'Give me a quick summary of',
    },
    {
      id: 'market-analysis',
      label: 'Market Analysis',
      description: 'Industry trends, competitors, and opportunities',
      prompt: 'Analyze the market for',
    },
    {
      id: 'academic-research',
      label: 'Academic Research',
      description: 'Scholarly articles and citation-based research',
      prompt: 'Find academic research on',
    },
  ],
  docs: [
    {
      id: 'article',
      label: 'Article',
      description: 'Well-structured blog post or article',
      prompt: 'Write an article about',
    },
    {
      id: 'report',
      label: 'Report',
      description: 'Formal business or technical report',
      prompt: 'Create a detailed report on',
    },
    {
      id: 'memo',
      label: 'Memo',
      description: 'Internal communication document',
      prompt: 'Write a memo about',
    },
    {
      id: 'proposal',
      label: 'Proposal',
      description: 'Project or business proposal',
      prompt: 'Draft a proposal for',
    },
  ],
  image: [
    {
      id: 'creative-art',
      label: 'Creative Art',
      description: 'Artistic and imaginative visuals',
      prompt: 'Generate a creative image of',
    },
    {
      id: 'professional-photo',
      label: 'Professional Photo',
      description: 'Realistic, high-quality photography',
      prompt: 'Create a professional photo of',
    },
    {
      id: 'illustration',
      label: 'Illustration',
      description: 'Custom illustrations and graphics',
      prompt: 'Illustrate',
    },
    {
      id: 'logo-design',
      label: 'Logo Design',
      description: 'Brand identity and logo concepts',
      prompt: 'Design a logo for',
    },
  ],
  data: [
    {
      id: 'analyze-csv',
      label: 'Analyze Data',
      description: 'Extract insights from your datasets',
      prompt: 'Analyze this data and provide insights:',
    },
    {
      id: 'create-chart',
      label: 'Create Chart',
      description: 'Visualize data with charts and graphs',
      prompt: 'Create a chart showing',
    },
    {
      id: 'data-summary',
      label: 'Data Summary',
      description: 'Statistical overview and key metrics',
      prompt: 'Summarize the key statistics for',
    },
    {
      id: 'trend-analysis',
      label: 'Trend Analysis',
      description: 'Identify patterns and forecasts',
      prompt: 'Analyze trends in',
    },
  ],
  people: [
    {
      id: 'team-intro',
      label: 'Team Introduction',
      description: 'Present team members and their roles',
      prompt: 'Create team introductions for',
    },
    {
      id: 'bio-profile',
      label: 'Bio & Profile',
      description: 'Professional biographies and profiles',
      prompt: 'Write a professional bio for',
    },
    {
      id: 'org-chart',
      label: 'Org Chart',
      description: 'Organization structure and hierarchy',
      prompt: 'Create an organizational chart for',
    },
    {
      id: 'contact-list',
      label: 'Contact List',
      description: 'Formatted contact information',
      prompt: 'Format contact information for',
    },
  ],
};

export function getModeOptions(modeId: string): ModeOption[] {
  return MODE_OPTIONS[modeId] || [];
}
