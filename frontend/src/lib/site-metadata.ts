/**
 * Site metadata configuration - SINGLE SOURCE OF TRUTH
 * No JSX, no React imports, no client-side code
 * Safe to use in Server Components for metadata generation
 */

export const siteMetadata = {
  name: 'Kortix',
  title: 'Kortix: Your Autonomous AI Worker',
  description: 'Built for complex tasks, designed for everything. The ultimate AI assistant that handles it all—from simple requests to mega-complex projects.',
  url: process.env.NEXT_PUBLIC_APP_URL || 'https://kortix.com',
  keywords: [
    'Kortix',
    'Autonomous AI Worker',
    'AI Worker',
    'Generalist AI',
    'Open Source AI',
    'Autonomous Agent',
    'Complex Tasks',
    'AI Assistant',
    'AI productivity',
    'workflow automation',
    'task automation',
    'browser automation',
    'research assistant',
    'data analysis',
  ],
  author: {
    name: 'Kortix Team',
    url: 'https://kortix.com',
  },
  social: {
    twitter: '@kortix',
    github: 'https://github.com/Kortix-ai/Suna',
  },
  images: {
    banner: '/banner.png',
    favicon: '/favicon.png',
    faviconDark: '/favicon-light.png',
    appleTouchIcon: '/logo_black.png',
  },
};
