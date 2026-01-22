import * as React from 'react';
import { View, StyleSheet } from 'react-native';
import { useColorScheme } from 'nativewind';
import { LinearGradient } from 'expo-linear-gradient';
import { 
  BookMarked, Microscope, Newspaper, Globe, 
  Library, FileText, ScrollText, Database,
  Search, Star, ExternalLink, Hash
} from 'lucide-react-native';
import { Icon } from '@/components/ui/icon';

interface ResearchPreviewCardProps {
  researchType: string;
  width: number;
  height: number;
}

// Research preview configurations
const RESEARCH_CONFIGS: Record<string, {
  gradient: { light: [string, string]; dark: [string, string] };
  accent: { light: string; dark: string };
  secondaryAccent: { light: string; dark: string };
  icon: any;
  layout: 'search' | 'cards' | 'list' | 'grid' | 'shelf' | 'journal' | 'paper' | 'table';
}> = {
  academic: {
    gradient: { 
      light: ['#FDF4FF', '#FAE8FF'], 
      dark: ['#2D1F3D', '#1A1225'] 
    },
    accent: { light: '#A855F7', dark: '#C084FC' },
    secondaryAccent: { light: '#7C3AED', dark: '#A78BFA' },
    icon: BookMarked,
    layout: 'cards',
  },
  scientific: {
    gradient: { 
      light: ['#ECFEFF', '#CFFAFE'], 
      dark: ['#0C2A2E', '#061A1E'] 
    },
    accent: { light: '#06B6D4', dark: '#22D3EE' },
    secondaryAccent: { light: '#0891B2', dark: '#67E8F9' },
    icon: Microscope,
    layout: 'grid',
  },
  news: {
    gradient: { 
      light: ['#FEF2F2', '#FEE2E2'], 
      dark: ['#2D1F1F', '#1A1212'] 
    },
    accent: { light: '#EF4444', dark: '#F87171' },
    secondaryAccent: { light: '#DC2626', dark: '#FCA5A5' },
    icon: Newspaper,
    layout: 'list',
  },
  web: {
    gradient: { 
      light: ['#F0FDF4', '#DCFCE7'], 
      dark: ['#0F2818', '#091A10'] 
    },
    accent: { light: '#22C55E', dark: '#4ADE80' },
    secondaryAccent: { light: '#16A34A', dark: '#86EFAC' },
    icon: Globe,
    layout: 'search',
  },
  books: {
    gradient: { 
      light: ['#FFFBEB', '#FEF3C7'], 
      dark: ['#2D2612', '#1A160A'] 
    },
    accent: { light: '#F59E0B', dark: '#FBBF24' },
    secondaryAccent: { light: '#D97706', dark: '#FCD34D' },
    icon: Library,
    layout: 'shelf',
  },
  articles: {
    gradient: { 
      light: ['#EFF6FF', '#DBEAFE'], 
      dark: ['#1E2A3D', '#0F172A'] 
    },
    accent: { light: '#3B82F6', dark: '#60A5FA' },
    secondaryAccent: { light: '#2563EB', dark: '#93C5FD' },
    icon: FileText,
    layout: 'journal',
  },
  papers: {
    gradient: { 
      light: ['#F5F5F4', '#E7E5E4'], 
      dark: ['#292524', '#1C1917'] 
    },
    accent: { light: '#78716C', dark: '#A8A29E' },
    secondaryAccent: { light: '#57534E', dark: '#D6D3D1' },
    icon: ScrollText,
    layout: 'paper',
  },
  database: {
    gradient: { 
      light: ['#F0FDFA', '#CCFBF1'], 
      dark: ['#0D2926', '#061A17'] 
    },
    accent: { light: '#14B8A6', dark: '#2DD4BF' },
    secondaryAccent: { light: '#0D9488', dark: '#5EEAD4' },
    icon: Database,
    layout: 'table',
  },
};

export const ResearchPreviewCard = React.memo(function ResearchPreviewCard({
  researchType,
  width,
  height,
}: ResearchPreviewCardProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  const config = RESEARCH_CONFIGS[researchType] || RESEARCH_CONFIGS.web;
  const gradient: [string, string] = isDark ? config.gradient.dark : config.gradient.light;
  const accent = isDark ? config.accent.dark : config.accent.light;
  const secondaryAccent = isDark ? config.secondaryAccent.dark : config.secondaryAccent.light;
  
  const lineColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';
  const textColor = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)';
  const subtleColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  
  const padding = width * 0.1;

  const renderLayout = () => {
    switch (config.layout) {
      case 'search':
        return (
          <View style={styles.layoutContainer}>
            {/* Search bar */}
            <View style={[styles.searchBar, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.8)', borderColor: lineColor }]}>
              <Icon as={Search} size={10} color={accent} strokeWidth={2.5} />
              <View style={[styles.searchText, { backgroundColor: textColor, width: '60%' }]} />
            </View>
            {/* Search results */}
            {[0, 1, 2].map((i) => (
              <View key={i} style={[styles.searchResult, { backgroundColor: subtleColor }]}>
                <View style={[styles.resultIcon, { backgroundColor: i === 0 ? accent : lineColor }]}>
                  <Icon as={ExternalLink} size={6} color={isDark ? '#000' : '#fff'} strokeWidth={2} />
                </View>
                <View style={styles.resultContent}>
                  <View style={[styles.resultTitle, { backgroundColor: i === 0 ? accent : textColor, opacity: i === 0 ? 0.7 : 1, width: `${70 - i * 10}%` }]} />
                  <View style={[styles.resultUrl, { backgroundColor: secondaryAccent, opacity: 0.4, width: `${50 - i * 5}%` }]} />
                </View>
              </View>
            ))}
          </View>
        );

      case 'cards':
        return (
          <View style={styles.layoutContainer}>
            {/* Academic cards grid */}
            <View style={styles.cardsGrid}>
              {[0, 1, 2, 3].map((i) => (
                <View 
                  key={i} 
                  style={[
                    styles.academicCard, 
                    { 
                      backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.8)',
                      borderColor: i === 0 ? accent : lineColor,
                      borderWidth: i === 0 ? 1.5 : 1,
                    }
                  ]}
                >
                  <View style={[styles.cardBadge, { backgroundColor: i === 0 ? accent : lineColor }]} />
                  <View style={[styles.cardLine, { backgroundColor: textColor, width: '80%' }]} />
                  <View style={[styles.cardLine, { backgroundColor: textColor, width: '60%', marginTop: 3 }]} />
                  {i === 0 && (
                    <View style={[styles.cardCitation, { backgroundColor: secondaryAccent, opacity: 0.5 }]}>
                      <View style={[styles.citationDot, { backgroundColor: secondaryAccent }]} />
                    </View>
                  )}
                </View>
              ))}
            </View>
          </View>
        );

      case 'list':
        return (
          <View style={styles.layoutContainer}>
            {/* News headline style */}
            <View style={[styles.newsHeader, { borderBottomColor: accent }]}>
              <View style={[styles.newsCategory, { backgroundColor: accent }]} />
              <View style={[styles.newsDate, { backgroundColor: textColor }]} />
            </View>
            {[0, 1, 2].map((i) => (
              <View key={i} style={styles.newsItem}>
                <View style={[styles.newsDot, { backgroundColor: i === 0 ? accent : textColor }]} />
                <View style={styles.newsContent}>
                  <View style={[styles.newsTitle, { backgroundColor: i === 0 ? accent : textColor, opacity: i === 0 ? 0.8 : 1, width: `${85 - i * 10}%` }]} />
                  <View style={[styles.newsMeta, { backgroundColor: subtleColor, width: `${40 + i * 5}%` }]} />
                </View>
              </View>
            ))}
          </View>
        );

      case 'grid':
        return (
          <View style={styles.layoutContainer}>
            {/* Scientific data grid */}
            <View style={[styles.sciHeader, { backgroundColor: subtleColor }]}>
              <Icon as={config.icon} size={10} color={accent} strokeWidth={2} />
              <View style={[styles.sciTitle, { backgroundColor: accent, opacity: 0.6 }]} />
            </View>
            <View style={styles.sciGrid}>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <View 
                  key={i} 
                  style={[
                    styles.sciCell, 
                    { 
                      backgroundColor: i < 2 ? `${accent}20` : subtleColor,
                      borderColor: lineColor,
                    }
                  ]}
                >
                  <View style={[styles.sciValue, { backgroundColor: i < 2 ? accent : textColor, opacity: i < 2 ? 0.7 : 1 }]} />
                </View>
              ))}
            </View>
            <View style={[styles.sciFooter, { backgroundColor: secondaryAccent, opacity: 0.3 }]} />
          </View>
        );

      case 'shelf':
        return (
          <View style={styles.layoutContainer}>
            {/* Bookshelf style */}
            <View style={styles.bookshelf}>
              {[0, 1, 2, 3, 4].map((i) => (
                <View 
                  key={i} 
                  style={[
                    styles.book, 
                    { 
                      backgroundColor: i === 1 ? accent : i === 3 ? secondaryAccent : 
                        isDark ? `rgba(255,255,255,${0.08 + i * 0.02})` : `rgba(0,0,0,${0.06 + i * 0.02})`,
                      height: `${60 + (i % 3) * 15}%`,
                    }
                  ]}
                >
                  <View style={[styles.bookSpine, { backgroundColor: isDark ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.3)' }]} />
                </View>
              ))}
            </View>
            <View style={[styles.shelfBoard, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' }]} />
            {/* Second row */}
            <View style={[styles.bookshelf, { marginTop: 4 }]}>
              {[0, 1, 2, 3].map((i) => (
                <View 
                  key={i} 
                  style={[
                    styles.book, 
                    { 
                      backgroundColor: i === 2 ? accent : 
                        isDark ? `rgba(255,255,255,${0.06 + i * 0.02})` : `rgba(0,0,0,${0.05 + i * 0.02})`,
                      height: `${55 + ((i + 1) % 3) * 15}%`,
                      width: 8 + (i % 2) * 2,
                    }
                  ]}
                />
              ))}
            </View>
            <View style={[styles.shelfBoard, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' }]} />
          </View>
        );

      case 'journal':
        return (
          <View style={styles.layoutContainer}>
            {/* Journal/Magazine style */}
            <View style={[styles.journalCover, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.9)', borderColor: accent }]}>
              <View style={[styles.journalHeader, { backgroundColor: accent }]}>
                <View style={[styles.journalLogo, { backgroundColor: isDark ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.5)' }]} />
              </View>
              <View style={styles.journalBody}>
                <View style={[styles.journalTitle, { backgroundColor: textColor, width: '75%' }]} />
                <View style={[styles.journalTitle, { backgroundColor: textColor, width: '55%', marginTop: 3 }]} />
                <View style={styles.journalMeta}>
                  <View style={[styles.journalAuthor, { backgroundColor: secondaryAccent, opacity: 0.5 }]} />
                  <View style={[styles.journalDoi, { backgroundColor: subtleColor }]} />
                </View>
              </View>
              <View style={[styles.journalFooter, { borderTopColor: lineColor }]}>
                <View style={[styles.journalTag, { backgroundColor: accent, opacity: 0.2 }]} />
                <View style={[styles.journalTag, { backgroundColor: secondaryAccent, opacity: 0.2 }]} />
              </View>
            </View>
          </View>
        );

      case 'paper':
        return (
          <View style={styles.layoutContainer}>
            {/* Academic paper style */}
            <View style={[styles.paperDoc, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.9)', borderColor: lineColor }]}>
              {/* Paper header */}
              <View style={styles.paperHeader}>
                <View style={[styles.paperTitle, { backgroundColor: accent, opacity: 0.7, width: '80%' }]} />
                <View style={[styles.paperTitle, { backgroundColor: textColor, width: '50%', marginTop: 3, height: 2 }]} />
              </View>
              {/* Authors */}
              <View style={styles.paperAuthors}>
                {[0, 1, 2].map((i) => (
                  <View key={i} style={[styles.authorDot, { backgroundColor: secondaryAccent, opacity: 0.5 - i * 0.1 }]} />
                ))}
              </View>
              {/* Abstract indicator */}
              <View style={[styles.abstractLabel, { backgroundColor: accent, opacity: 0.4 }]} />
              {/* Abstract lines */}
              {[0, 1, 2].map((i) => (
                <View 
                  key={i} 
                  style={[
                    styles.abstractLine, 
                    { 
                      backgroundColor: textColor, 
                      width: i === 2 ? '70%' : '100%',
                      marginTop: i === 0 ? 4 : 3,
                    }
                  ]} 
                />
              ))}
            </View>
          </View>
        );

      case 'table':
        return (
          <View style={styles.layoutContainer}>
            {/* Database table style */}
            <View style={[styles.tableContainer, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.9)', borderColor: lineColor }]}>
              {/* Table header */}
              <View style={[styles.tableHeader, { backgroundColor: accent, opacity: 0.15 }]}>
                {[0, 1, 2].map((i) => (
                  <View key={i} style={[styles.tableHeaderCell, { backgroundColor: accent, opacity: 0.8 }]} />
                ))}
              </View>
              {/* Table rows */}
              {[0, 1, 2].map((row) => (
                <View key={row} style={[styles.tableRow, { backgroundColor: row % 2 === 0 ? 'transparent' : subtleColor }]}>
                  {[0, 1, 2].map((col) => (
                    <View 
                      key={col} 
                      style={[
                        styles.tableCell, 
                        { 
                          backgroundColor: col === 0 && row === 0 ? secondaryAccent : textColor,
                          opacity: col === 0 && row === 0 ? 0.6 : 1,
                          width: col === 0 ? '70%' : `${50 + (row + col) * 5}%`,
                        }
                      ]} 
                    />
                  ))}
                </View>
              ))}
            </View>
            {/* Query indicator */}
            <View style={[styles.queryBar, { backgroundColor: subtleColor }]}>
              <Icon as={Hash} size={8} color={accent} strokeWidth={2} />
              <View style={[styles.queryText, { backgroundColor: accent, opacity: 0.4 }]} />
            </View>
          </View>
        );

      default:
        return null;
    }
  };

  return (
    <View style={[styles.container, { width, height, borderRadius: 12 }]}>
      <LinearGradient
        colors={gradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.gradient, { borderRadius: 12 }]}
      >
        <View style={[styles.content, { padding }]}>
          {renderLayout()}
        </View>
      </LinearGradient>

      {/* Corner icon badge */}
      <View 
        style={[
          styles.iconBadge, 
          { 
            backgroundColor: accent,
            shadowColor: accent,
          }
        ]}
      >
        <Icon as={config.icon} size={10} color={isDark ? '#000' : '#fff'} strokeWidth={2.5} />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  gradient: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
  iconBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 22,
    height: 22,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
  layoutContainer: {
    flex: 1,
  },

  // Search layout
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    gap: 6,
    marginBottom: 8,
  },
  searchText: {
    height: 3,
    borderRadius: 1.5,
  },
  searchResult: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 6,
    borderRadius: 6,
    marginBottom: 4,
    gap: 6,
  },
  resultIcon: {
    width: 14,
    height: 14,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resultContent: {
    flex: 1,
    gap: 3,
  },
  resultTitle: {
    height: 3,
    borderRadius: 1.5,
  },
  resultUrl: {
    height: 2,
    borderRadius: 1,
  },

  // Cards layout (Academic)
  cardsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  academicCard: {
    width: '47%',
    padding: 6,
    borderRadius: 6,
    borderWidth: 1,
  },
  cardBadge: {
    width: 12,
    height: 3,
    borderRadius: 1.5,
    marginBottom: 4,
  },
  cardLine: {
    height: 2,
    borderRadius: 1,
  },
  cardCitation: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    gap: 3,
  },
  citationDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
  },

  // News list layout
  newsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 6,
    marginBottom: 6,
    borderBottomWidth: 2,
  },
  newsCategory: {
    width: 30,
    height: 4,
    borderRadius: 2,
  },
  newsDate: {
    width: 20,
    height: 3,
    borderRadius: 1.5,
  },
  newsItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 6,
    gap: 6,
  },
  newsDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    marginTop: 2,
  },
  newsContent: {
    flex: 1,
    gap: 3,
  },
  newsTitle: {
    height: 3,
    borderRadius: 1.5,
  },
  newsMeta: {
    height: 2,
    borderRadius: 1,
  },

  // Scientific grid
  sciHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 5,
    borderRadius: 5,
    gap: 6,
    marginBottom: 6,
  },
  sciTitle: {
    width: 40,
    height: 3,
    borderRadius: 1.5,
  },
  sciGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  sciCell: {
    width: '30%',
    aspectRatio: 1.5,
    borderRadius: 4,
    borderWidth: 1,
    padding: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sciValue: {
    width: '60%',
    height: 3,
    borderRadius: 1.5,
  },
  sciFooter: {
    height: 4,
    borderRadius: 2,
    marginTop: 6,
  },

  // Bookshelf
  bookshelf: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 35,
    gap: 3,
    paddingHorizontal: 2,
  },
  book: {
    width: 10,
    borderRadius: 2,
    overflow: 'hidden',
  },
  bookSpine: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 2,
  },
  shelfBoard: {
    height: 3,
    borderRadius: 1,
    marginTop: 2,
  },

  // Journal
  journalCover: {
    flex: 1,
    borderRadius: 6,
    borderWidth: 1.5,
    overflow: 'hidden',
  },
  journalHeader: {
    height: 16,
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  journalLogo: {
    width: 20,
    height: 4,
    borderRadius: 2,
  },
  journalBody: {
    flex: 1,
    padding: 6,
  },
  journalTitle: {
    height: 3,
    borderRadius: 1.5,
  },
  journalMeta: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 8,
  },
  journalAuthor: {
    width: 25,
    height: 2,
    borderRadius: 1,
  },
  journalDoi: {
    width: 20,
    height: 2,
    borderRadius: 1,
  },
  journalFooter: {
    flexDirection: 'row',
    gap: 4,
    padding: 5,
    borderTopWidth: 1,
  },
  journalTag: {
    width: 18,
    height: 4,
    borderRadius: 2,
  },

  // Paper
  paperDoc: {
    flex: 1,
    borderRadius: 6,
    borderWidth: 1,
    padding: 8,
  },
  paperHeader: {
    marginBottom: 6,
  },
  paperTitle: {
    height: 3,
    borderRadius: 1.5,
  },
  paperAuthors: {
    flexDirection: 'row',
    gap: 4,
    marginBottom: 8,
  },
  authorDot: {
    width: 10,
    height: 3,
    borderRadius: 1.5,
  },
  abstractLabel: {
    width: 25,
    height: 3,
    borderRadius: 1.5,
  },
  abstractLine: {
    height: 2,
    borderRadius: 1,
  },

  // Database table
  tableContainer: {
    flex: 1,
    borderRadius: 6,
    borderWidth: 1,
    overflow: 'hidden',
  },
  tableHeader: {
    flexDirection: 'row',
    paddingVertical: 5,
    paddingHorizontal: 6,
    gap: 8,
  },
  tableHeaderCell: {
    width: 18,
    height: 3,
    borderRadius: 1.5,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 4,
    paddingHorizontal: 6,
    gap: 8,
  },
  tableCell: {
    height: 2,
    borderRadius: 1,
  },
  queryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 4,
    gap: 4,
    marginTop: 6,
  },
  queryText: {
    width: 35,
    height: 2,
    borderRadius: 1,
  },
});
