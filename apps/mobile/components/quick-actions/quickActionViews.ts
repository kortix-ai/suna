import { 
  BarChart3, PieChart, LineChart, Table, Calculator, Presentation as PresentationIcon,
  ScrollText, FileCheck, MessageSquare, Newspaper, Notebook, FileEdit,
  UserCheck, Users2, UserSearch, Handshake, Crown, Target,
  BookMarked, Globe, Microscope, Library, Lightbulb, Database,
  TrendingUp, Mail, FileText, GraduationCap
} from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';

export interface QuickActionOption {
  id: string;
  label: string;
  icon?: LucideIcon;
  imageUrl?: any;
}

/**
 * Quick Action Views Configuration
 * 
 * Defines custom UI options that appear when each quick action is selected.
 */

// Image Generation Styles
export const IMAGE_STYLES: QuickActionOption[] = [
  { id: 'abstract', label: 'Abstract', imageUrl: require('@/assets/images/quick-actions/image-styles/abstract_organic-min.png') },
  { id: 'anime', label: 'Anime', imageUrl: require('@/assets/images/quick-actions/image-styles/anime_forest-min.png') },
  { id: 'comic', label: 'Comic', imageUrl: require('@/assets/images/quick-actions/image-styles/comic_book_robot-min.png') },
  { id: 'digital-art', label: 'Digital', imageUrl: require('@/assets/images/quick-actions/image-styles/digital_art_cyberpunk-min.png') },
  { id: 'geometric', label: 'Geometric', imageUrl: require('@/assets/images/quick-actions/image-styles/geometric_crystal-min.png') },
  { id: 'impressionist', label: 'Impressionist', imageUrl: require('@/assets/images/quick-actions/image-styles/impressionist_garden-min.png') },
  { id: 'isometric', label: 'Isometric', imageUrl: require('@/assets/images/quick-actions/image-styles/isometric_bedroom-min.png') },
  { id: 'minimalist', label: 'Minimalist', imageUrl: require('@/assets/images/quick-actions/image-styles/minimalist_coffee-min.png') },
  { id: 'neon', label: 'Neon', imageUrl: require('@/assets/images/quick-actions/image-styles/neon_jellyfish-min.png') },
  { id: 'oil-painting', label: 'Oil Paint', imageUrl: require('@/assets/images/quick-actions/image-styles/oil_painting_villa-min.png') },
  { id: 'pastel', label: 'Pastel', imageUrl: require('@/assets/images/quick-actions/image-styles/pastel_landscape-min.png') },
  { id: 'photorealistic', label: 'Photo', imageUrl: require('@/assets/images/quick-actions/image-styles/photorealistic_eagle-min.png') },
  { id: 'surreal', label: 'Surreal', imageUrl: require('@/assets/images/quick-actions/image-styles/surreal_islands-min.png') },
  { id: 'vintage', label: 'Vintage', imageUrl: require('@/assets/images/quick-actions/image-styles/vintage_diner-min.png') },
  { id: 'watercolor', label: 'Watercolor', imageUrl: require('@/assets/images/quick-actions/image-styles/watercolor_garden-min.png') },
];

// Slides Templates
export const SLIDES_TEMPLATES: QuickActionOption[] = [
  { id: 'minimalist', label: 'Minimalist', imageUrl: require('@/assets/images/quick-actions/presentation-templates/minimalist-min.png') },
  { id: 'minimalist_2', label: 'Minimalist 2', imageUrl: require('@/assets/images/quick-actions/presentation-templates/minimalist_2-min.png') },
  { id: 'black_and_white_clean', label: 'Black & White', imageUrl: require('@/assets/images/quick-actions/presentation-templates/black_and_white_clean-min.png') },
  { id: 'colorful', label: 'Colorful', imageUrl: require('@/assets/images/quick-actions/presentation-templates/colorful-min.png') },
  { id: 'startup', label: 'Startup', imageUrl: require('@/assets/images/quick-actions/presentation-templates/startup-min.png') },
  { id: 'elevator_pitch', label: 'Elevator Pitch', imageUrl: require('@/assets/images/quick-actions/presentation-templates/elevator_pitch-min.png') },
  { id: 'portfolio', label: 'Portfolio', imageUrl: require('@/assets/images/quick-actions/presentation-templates/portfolio-min.png') },
  { id: 'textbook', label: 'Textbook', imageUrl: require('@/assets/images/quick-actions/presentation-templates/textbook-min.png') },
  { id: 'architect', label: 'Architect', imageUrl: require('@/assets/images/quick-actions/presentation-templates/architect-min.png') },
  { id: 'hipster', label: 'Hipster', imageUrl: require('@/assets/images/quick-actions/presentation-templates/hipster-min.png') },
  { id: 'green', label: 'Green', imageUrl: require('@/assets/images/quick-actions/presentation-templates/green-min.png') },
  { id: 'premium_black', label: 'Premium Black', imageUrl: require('@/assets/images/quick-actions/presentation-templates/premium_black-min.png') },
  { id: 'premium_green', label: 'Premium Green', imageUrl: require('@/assets/images/quick-actions/presentation-templates/premium_green-min.png') },
  { id: 'professor_gray', label: 'Professor Gray', imageUrl: require('@/assets/images/quick-actions/presentation-templates/professor_gray-min.png') },
  { id: 'gamer_gray', label: 'Gamer Gray', imageUrl: require('@/assets/images/quick-actions/presentation-templates/gamer_gray-min.png') },
  { id: 'competitor_analysis_blue', label: 'Analysis Blue', imageUrl: require('@/assets/images/quick-actions/presentation-templates/competitor_analysis_blue-min.png') },
  { id: 'numbers_clean', label: 'Numbers Clean', imageUrl: require('@/assets/images/quick-actions/presentation-templates/numbers_clean-min.png') },
  { id: 'numbers_colorful', label: 'Numbers Colorful', imageUrl: require('@/assets/images/quick-actions/presentation-templates/numbers_colorful-min.png') },
];

// Data Analysis Types
export const DATA_TYPES: QuickActionOption[] = [
  { id: 'chart', label: 'Charts', icon: BarChart3 },
  { id: 'table', label: 'Tables', icon: Table },
  { id: 'pie-chart', label: 'Pie Chart', icon: PieChart },
  { id: 'line-graph', label: 'Line Graph', icon: LineChart },
  { id: 'statistics', label: 'Statistics', icon: Calculator },
  { id: 'comparison', label: 'Compare', icon: PresentationIcon },
  { id: 'trends', label: 'Trends', icon: TrendingUp },
  { id: 'summary', label: 'Summary', icon: FileCheck },
];

// Document Types
export const DOCUMENT_TYPES: QuickActionOption[] = [
  { id: 'essay', label: 'Essay', icon: ScrollText },
  { id: 'letter', label: 'Letter', icon: Mail },
  { id: 'report', label: 'Report', icon: FileText },
  { id: 'email', label: 'Email', icon: Mail },
  { id: 'article', label: 'Article', icon: Newspaper },
  { id: 'notes', label: 'Notes', icon: Notebook },
  { id: 'blog-post', label: 'Blog Post', icon: FileEdit },
  { id: 'summary', label: 'Summary', icon: MessageSquare },
];

// People Search Types
export const PEOPLE_TYPES: QuickActionOption[] = [
  { id: 'expert', label: 'Expert', icon: Crown },
  { id: 'colleague', label: 'Colleague', icon: UserCheck },
  { id: 'contact', label: 'Contact', icon: UserSearch },
  { id: 'team', label: 'Team', icon: Users2 },
  { id: 'partner', label: 'Partner', icon: Handshake },
  { id: 'influencer', label: 'Influencer', icon: Target },
  { id: 'mentor', label: 'Mentor', icon: GraduationCap },
  { id: 'advisor', label: 'Advisor', icon: Lightbulb },
];

// Research Sources
export const RESEARCH_SOURCES: QuickActionOption[] = [
  { id: 'academic', label: 'Academic', icon: BookMarked },
  { id: 'scientific', label: 'Scientific', icon: Microscope },
  { id: 'news', label: 'News', icon: Newspaper },
  { id: 'web', label: 'Web', icon: Globe },
  { id: 'books', label: 'Books', icon: Library },
  { id: 'articles', label: 'Articles', icon: FileText },
  { id: 'papers', label: 'Papers', icon: ScrollText },
  { id: 'database', label: 'Database', icon: Database },
];

/**
 * Get options for a specific quick action
 */
export function getQuickActionOptions(actionId: string): QuickActionOption[] {
  switch (actionId) {
    case 'image':
      return IMAGE_STYLES;
    case 'slides':
      return SLIDES_TEMPLATES;
    case 'data':
      return DATA_TYPES;
    case 'docs':
      return DOCUMENT_TYPES;
    case 'people':
      return PEOPLE_TYPES;
    case 'research':
      return RESEARCH_SOURCES;
    default:
      return [];
  }
}

