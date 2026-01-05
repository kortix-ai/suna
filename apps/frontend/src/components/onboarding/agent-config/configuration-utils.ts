import { ConfigurationField } from '../shared/types';
import { integrationsByAgent } from '../shared/data';

// Configuration fields for each agent type
export const getConfigurationFields = (agentId: string): ConfigurationField[] => {
  const configs: { [key: string]: ConfigurationField[] } = {
    maya: [
      { key: 'contentTypes', label: 'Content Types', type: 'multiselect', options: ['Blog Posts', 'Social Media', 'Email Campaigns', 'Website Copy', 'Product Descriptions'], description: 'What types of content should Maya focus on?' },
      { key: 'writingStyle', label: 'Writing Style', type: 'select', options: ['Professional', 'Casual', 'Creative', 'Technical', 'Persuasive'], default: 'Professional' },
      { key: 'targetAudience', label: 'Target Audience', type: 'select', options: ['B2B', 'B2C', 'Technical', 'General Public', 'Industry Specific'], default: 'B2B' },
      { key: 'contentGoals', label: 'Content Goals', type: 'multiselect', options: ['Brand Awareness', 'Lead Generation', 'SEO', 'Engagement', 'Education'] }
    ],
    hunter: [
      { key: 'roles', label: 'Typical Roles to Recruit', type: 'multiselect', options: ['Software Engineers', 'Designers', 'Product Managers', 'Sales', 'Marketing', 'Operations'] },
      { key: 'experienceLevel', label: 'Experience Level Focus', type: 'select', options: ['Entry Level', 'Mid Level', 'Senior Level', 'Executive', 'All Levels'], default: 'Mid Level' },
      { key: 'industries', label: 'Industry Focus', type: 'multiselect', options: ['Technology', 'Finance', 'Healthcare', 'E-commerce', 'Consulting', 'Startups'] },
      { key: 'recruitmentStyle', label: 'Recruitment Approach', type: 'select', options: ['Active Sourcing', 'Passive Candidates', 'University Recruiting', 'Referrals'], default: 'Active Sourcing' }
    ],
    nova: [
      { key: 'seoFocus', label: 'SEO Focus Areas', type: 'multiselect', options: ['Keyword Research', 'On-Page SEO', 'Technical SEO', 'Link Building', 'Local SEO', 'Content Optimization'] },
      { key: 'industry', label: 'Industry Specialization', type: 'select', options: ['E-commerce', 'SaaS', 'Local Business', 'B2B Services', 'Content/Media', 'General'], default: 'General' },
      { key: 'competitorAnalysis', label: 'Competitor Analysis', type: 'select', options: ['Weekly', 'Monthly', 'Quarterly', 'As Needed'], default: 'Monthly' },
      { key: 'reportingFrequency', label: 'Reporting Frequency', type: 'select', options: ['Daily', 'Weekly', 'Bi-weekly', 'Monthly'], default: 'Weekly' }
    ],
    sage: [
      { key: 'dataTypes', label: 'Data Types to Analyze', type: 'multiselect', options: ['Website Analytics', 'Sales Data', 'Customer Data', 'Marketing Metrics', 'Financial Data', 'Operational Data'] },
      { key: 'reportingStyle', label: 'Reporting Style', type: 'select', options: ['Executive Summary', 'Detailed Reports', 'Visual Dashboards', 'Data-Driven Insights'], default: 'Executive Summary' },
      { key: 'analysisFrequency', label: 'Analysis Frequency', type: 'select', options: ['Real-time', 'Daily', 'Weekly', 'Monthly'], default: 'Weekly' },
      { key: 'kpiTracking', label: 'KPI Focus', type: 'multiselect', options: ['Revenue', 'Growth', 'Customer Acquisition', 'Retention', 'Conversion', 'Efficiency'] }
    ],
    alex: [
      { key: 'customerSegments', label: 'Customer Segments', type: 'multiselect', options: ['Enterprise', 'SMB', 'Startups', 'Individual', 'Non-profit'] },
      { key: 'supportChannels', label: 'Support Channels', type: 'multiselect', options: ['Email', 'Chat', 'Phone', 'Video Calls', 'Knowledge Base'] },
      { key: 'responseTime', label: 'Target Response Time', type: 'select', options: ['Immediate', '1 Hour', '4 Hours', '24 Hours'], default: '4 Hours' },
      { key: 'successMetrics', label: 'Success Metrics', type: 'multiselect', options: ['Customer Satisfaction', 'Response Time', 'Resolution Rate', 'Retention', 'Upsells'] }
    ],
    byte: [
      { key: 'programmingLanguages', label: 'Programming Languages', type: 'multiselect', options: ['JavaScript', 'Python', 'Java', 'TypeScript', 'Go', 'Rust', 'C++'] },
      { key: 'frameworks', label: 'Frameworks & Technologies', type: 'multiselect', options: ['React', 'Node.js', 'Django', 'Spring Boot', 'Next.js', 'Vue.js'] },
      { key: 'projectTypes', label: 'Project Types', type: 'multiselect', options: ['Web Applications', 'Mobile Apps', 'APIs', 'Microservices', 'Data Processing', 'DevOps'] },
      { key: 'codeQuality', label: 'Code Quality Focus', type: 'select', options: ['High Performance', 'Maintainability', 'Security', 'Scalability'], default: 'Maintainability' }
    ],
    pixel: [
      { key: 'designTypes', label: 'Design Focus', type: 'multiselect', options: ['Web Design', 'Mobile Apps', 'Branding', 'Marketing Materials', 'Product Design'] },
      { key: 'designStyle', label: 'Design Style Preference', type: 'select', options: ['Modern/Minimal', 'Creative/Artistic', 'Corporate/Professional', 'Playful/Fun'], default: 'Modern/Minimal' },
      { key: 'deliverables', label: 'Typical Deliverables', type: 'multiselect', options: ['Wireframes', 'Mockups', 'Prototypes', 'Design Systems', 'Assets', 'Documentation'] },
      { key: 'collaboration', label: 'Collaboration Style', type: 'select', options: ['Independent', 'Collaborative', 'Client-Facing', 'Team-Embedded'], default: 'Collaborative' }
    ],
    echo: [
      { key: 'salesProcess', label: 'Sales Process', type: 'multiselect', options: ['Lead Qualification', 'Demo/Presentation', 'Negotiation', 'Closing', 'Follow-up'] },
      { key: 'salesType', label: 'Sales Type', type: 'select', options: ['Inbound', 'Outbound', 'Channel', 'Enterprise', 'SMB'], default: 'Inbound' },
      { key: 'dealSize', label: 'Typical Deal Size', type: 'select', options: ['< $1K', '$1K-$10K', '$10K-$100K', '$100K+'], default: '$1K-$10K' },
      { key: 'salesMetrics', label: 'Sales Metrics Focus', type: 'multiselect', options: ['Conversion Rate', 'Deal Size', 'Sales Cycle', 'Pipeline Value', 'Activity Metrics'] }
    ]
  };
  
  return configs[agentId] || [];
};

// Get integration fields for an agent
export const getIntegrationFields = (agentId: string): ConfigurationField[] => {
  const integrations = integrationsByAgent[agentId] || [];
  
  if (integrations.length === 0) return [];
  
  return [
    {
      key: 'integrations',
      label: 'Connect Your Tools',
      type: 'integrations',
      options: integrations,
      description: `Select the tools and platforms you want ${agentId} to integrate with`
    }
  ];
};

// Calculate configuration completeness
export const getConfigurationCompleteness = (agentId: string, configuration: Record<string, any>) => {
  const fields = [...getConfigurationFields(agentId), ...getIntegrationFields(agentId)];
  const configuredFields = fields.filter(field => {
    const value = configuration[field.key];
    return value && (Array.isArray(value) ? value.length > 0 : true);
  });
  
  return {
    configured: configuredFields.length,
    total: fields.length,
    percentage: fields.length > 0 ? Math.round((configuredFields.length / fields.length) * 100) : 0
  };
};

