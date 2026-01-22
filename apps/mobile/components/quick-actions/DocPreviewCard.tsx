import * as React from 'react';
import { View, StyleSheet } from 'react-native';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { LinearGradient } from 'expo-linear-gradient';

interface DocPreviewCardProps {
  docType: string;
  width: number;
  height: number;
}

// Document preview configurations with colors and layouts
const DOC_CONFIGS: Record<string, {
  gradient: { light: [string, string]; dark: [string, string] };
  accent: { light: string; dark: string };
  headerLines: number;
  bodyLines: number;
  hasSignature?: boolean;
  hasSubject?: boolean;
  hasBullets?: boolean;
  hasQuote?: boolean;
  hasTitle?: boolean;
  hasSections?: boolean;
}> = {
  essay: {
    gradient: { 
      light: ['#FAFAFA', '#F5F5F5'], 
      dark: ['#2A2A2E', '#1E1E22'] 
    },
    accent: { light: '#6366F1', dark: '#818CF8' },
    headerLines: 1,
    bodyLines: 8,
    hasTitle: true,
  },
  letter: {
    gradient: { 
      light: ['#FFFBF5', '#FFF8ED'], 
      dark: ['#2D2A26', '#252220'] 
    },
    accent: { light: '#D97706', dark: '#FBBF24' },
    headerLines: 2,
    bodyLines: 5,
    hasSignature: true,
  },
  report: {
    gradient: { 
      light: ['#F8FAFC', '#F1F5F9'], 
      dark: ['#1E293B', '#0F172A'] 
    },
    accent: { light: '#0EA5E9', dark: '#38BDF8' },
    headerLines: 1,
    bodyLines: 4,
    hasTitle: true,
    hasSections: true,
  },
  email: {
    gradient: { 
      light: ['#FFFFFF', '#FAFAFA'], 
      dark: ['#27272A', '#18181B'] 
    },
    accent: { light: '#EC4899', dark: '#F472B6' },
    headerLines: 3,
    bodyLines: 4,
    hasSubject: true,
  },
  article: {
    gradient: { 
      light: ['#FEFCE8', '#FEF9C3'], 
      dark: ['#2C2A1F', '#1F1E18'] 
    },
    accent: { light: '#84CC16', dark: '#A3E635' },
    headerLines: 1,
    bodyLines: 6,
    hasTitle: true,
    hasQuote: true,
  },
  notes: {
    gradient: { 
      light: ['#FFF7ED', '#FFEDD5'], 
      dark: ['#2D2620', '#1F1B16'] 
    },
    accent: { light: '#F97316', dark: '#FB923C' },
    headerLines: 0,
    bodyLines: 5,
    hasBullets: true,
  },
  'blog-post': {
    gradient: { 
      light: ['#FAF5FF', '#F3E8FF'], 
      dark: ['#2E1F3D', '#1F1529'] 
    },
    accent: { light: '#A855F7', dark: '#C084FC' },
    headerLines: 1,
    bodyLines: 5,
    hasTitle: true,
    hasQuote: true,
  },
  summary: {
    gradient: { 
      light: ['#F0FDF4', '#DCFCE7'], 
      dark: ['#1A2E1A', '#132613'] 
    },
    accent: { light: '#22C55E', dark: '#4ADE80' },
    headerLines: 1,
    bodyLines: 3,
    hasBullets: true,
    hasTitle: true,
  },
};

export const DocPreviewCard = React.memo(function DocPreviewCard({
  docType,
  width,
  height,
}: DocPreviewCardProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  const config = DOC_CONFIGS[docType] || DOC_CONFIGS.essay;
  const gradient: [string, string] = isDark ? config.gradient.dark : config.gradient.light;
  const accent = isDark ? config.accent.dark : config.accent.light;
  
  const lineColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const textLineColor = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)';
  const shortLineColor = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)';
  
  const padding = width * 0.12;
  const lineHeight = 3;
  const lineGap = 6;
  const titleHeight = 5;

  return (
    <View style={[styles.container, { width, height, borderRadius: 12 }]}>
      <LinearGradient
        colors={gradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.gradient, { borderRadius: 12 }]}
      >
        {/* Paper effect with subtle inner shadow */}
        <View style={[styles.paper, { padding }]}>
          {/* Header section for email */}
          {config.hasSubject && (
            <View style={styles.emailHeader}>
              <View style={[styles.emailField, { backgroundColor: lineColor }]}>
                <View style={[styles.emailLabel, { backgroundColor: accent, opacity: 0.6 }]} />
                <View style={[styles.emailValue, { backgroundColor: textLineColor }]} />
              </View>
              <View style={[styles.emailField, { backgroundColor: lineColor }]}>
                <View style={[styles.emailLabel, { backgroundColor: accent, opacity: 0.4 }]} />
                <View style={[styles.emailValue, { backgroundColor: textLineColor, width: '60%' }]} />
              </View>
              <View style={[styles.divider, { backgroundColor: lineColor, marginTop: 6 }]} />
            </View>
          )}

          {/* Title for documents */}
          {config.hasTitle && !config.hasSubject && (
            <View style={styles.titleSection}>
              <View 
                style={[
                  styles.titleLine, 
                  { 
                    backgroundColor: accent, 
                    height: titleHeight,
                    width: '70%',
                    opacity: 0.8,
                  }
                ]} 
              />
              {config.hasSections && (
                <View 
                  style={[
                    styles.subtitleLine, 
                    { 
                      backgroundColor: textLineColor, 
                      height: lineHeight,
                      width: '40%',
                      marginTop: 4,
                    }
                  ]} 
                />
              )}
            </View>
          )}

          {/* Letter header (date + recipient) */}
          {config.hasSignature && (
            <View style={styles.letterHeader}>
              <View 
                style={[
                  styles.dateLine, 
                  { backgroundColor: shortLineColor, width: '35%', height: lineHeight }
                ]} 
              />
              <View style={{ height: 8 }} />
              <View 
                style={[
                  styles.recipientLine, 
                  { backgroundColor: textLineColor, width: '50%', height: lineHeight }
                ]} 
              />
            </View>
          )}

          {/* Body content */}
          <View style={styles.bodySection}>
            {config.hasBullets ? (
              // Bullet points layout
              <>
                {Array.from({ length: config.bodyLines }).map((_, index) => (
                  <View key={index} style={styles.bulletRow}>
                    <View 
                      style={[
                        styles.bullet, 
                        { 
                          backgroundColor: index === 0 ? accent : textLineColor,
                          opacity: index === 0 ? 0.8 : 0.6,
                        }
                      ]} 
                    />
                    <View 
                      style={[
                        styles.bulletText, 
                        { 
                          backgroundColor: textLineColor,
                          width: `${65 + (index % 3) * 10}%`,
                          height: lineHeight,
                        }
                      ]} 
                    />
                  </View>
                ))}
              </>
            ) : config.hasQuote ? (
              // Article/Blog with quote
              <>
                {Array.from({ length: 3 }).map((_, index) => (
                  <View 
                    key={index}
                    style={[
                      styles.textLine, 
                      { 
                        backgroundColor: textLineColor,
                        width: index === 2 ? '75%' : '100%',
                        height: lineHeight,
                        marginBottom: lineGap,
                      }
                    ]} 
                  />
                ))}
                <View style={[styles.quoteBlock, { borderLeftColor: accent }]}>
                  <View 
                    style={[
                      styles.quoteLine, 
                      { backgroundColor: shortLineColor, width: '85%', height: lineHeight }
                    ]} 
                  />
                  <View 
                    style={[
                      styles.quoteLine, 
                      { backgroundColor: shortLineColor, width: '60%', height: lineHeight, marginTop: 4 }
                    ]} 
                  />
                </View>
                {Array.from({ length: 2 }).map((_, index) => (
                  <View 
                    key={`after-${index}`}
                    style={[
                      styles.textLine, 
                      { 
                        backgroundColor: textLineColor,
                        width: index === 1 ? '55%' : '100%',
                        height: lineHeight,
                        marginBottom: lineGap,
                      }
                    ]} 
                  />
                ))}
              </>
            ) : config.hasSections ? (
              // Report with sections
              <>
                {Array.from({ length: 2 }).map((_, index) => (
                  <View 
                    key={index}
                    style={[
                      styles.textLine, 
                      { 
                        backgroundColor: textLineColor,
                        width: index === 1 ? '80%' : '100%',
                        height: lineHeight,
                        marginBottom: lineGap,
                      }
                    ]} 
                  />
                ))}
                <View 
                  style={[
                    styles.sectionHeader, 
                    { backgroundColor: accent, opacity: 0.5, width: '45%', height: 4, marginTop: 4, marginBottom: 6 }
                  ]} 
                />
                {Array.from({ length: 2 }).map((_, index) => (
                  <View 
                    key={`section-${index}`}
                    style={[
                      styles.textLine, 
                      { 
                        backgroundColor: textLineColor,
                        width: index === 1 ? '65%' : '90%',
                        height: lineHeight,
                        marginBottom: lineGap,
                      }
                    ]} 
                  />
                ))}
              </>
            ) : (
              // Standard paragraph lines
              <>
                {Array.from({ length: config.bodyLines }).map((_, index) => (
                  <View 
                    key={index}
                    style={[
                      styles.textLine, 
                      { 
                        backgroundColor: textLineColor,
                        width: index === config.bodyLines - 1 ? '60%' : 
                               index % 3 === 2 ? '85%' : '100%',
                        height: lineHeight,
                        marginBottom: lineGap,
                      }
                    ]} 
                  />
                ))}
              </>
            )}
          </View>

          {/* Signature for letters */}
          {config.hasSignature && (
            <View style={styles.signature}>
              <View 
                style={[
                  styles.signatureLine, 
                  { 
                    backgroundColor: accent, 
                    opacity: 0.6,
                    width: '30%', 
                    height: 3,
                    borderRadius: 2,
                  }
                ]} 
              />
              <View 
                style={[
                  styles.signatureName, 
                  { 
                    backgroundColor: textLineColor, 
                    width: '40%', 
                    height: lineHeight,
                    marginTop: 4,
                  }
                ]} 
              />
            </View>
          )}
        </View>

        {/* Subtle paper edge effect */}
        <View 
          style={[
            styles.paperEdge, 
            { 
              backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
              borderRadius: 12,
            }
          ]} 
        />
      </LinearGradient>

      {/* Colored accent bar at top */}
      <View 
        style={[
          styles.accentBar, 
          { 
            backgroundColor: accent,
            borderTopLeftRadius: 12,
            borderTopRightRadius: 12,
          }
        ]} 
      />
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
  paper: {
    flex: 1,
    justifyContent: 'flex-start',
  },
  paperEdge: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: 3,
  },
  accentBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 4,
  },
  emailHeader: {
    marginBottom: 8,
  },
  emailField: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 3,
    paddingHorizontal: 4,
    borderRadius: 3,
    marginBottom: 3,
  },
  emailLabel: {
    width: 16,
    height: 3,
    borderRadius: 1.5,
    marginRight: 6,
  },
  emailValue: {
    flex: 1,
    height: 3,
    borderRadius: 1.5,
  },
  divider: {
    height: 1,
  },
  titleSection: {
    marginBottom: 10,
  },
  titleLine: {
    borderRadius: 2,
  },
  subtitleLine: {
    borderRadius: 1.5,
  },
  letterHeader: {
    marginBottom: 10,
  },
  dateLine: {
    borderRadius: 1.5,
  },
  recipientLine: {
    borderRadius: 1.5,
  },
  bodySection: {
    flex: 1,
  },
  textLine: {
    borderRadius: 1.5,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 5,
  },
  bullet: {
    width: 4,
    height: 4,
    borderRadius: 2,
    marginRight: 6,
  },
  bulletText: {
    borderRadius: 1.5,
  },
  quoteBlock: {
    borderLeftWidth: 2,
    paddingLeft: 8,
    marginVertical: 6,
    paddingVertical: 4,
  },
  quoteLine: {
    borderRadius: 1.5,
  },
  sectionHeader: {
    borderRadius: 2,
  },
  signature: {
    marginTop: 8,
    alignItems: 'flex-start',
  },
  signatureLine: {
    transform: [{ rotate: '-3deg' }],
  },
  signatureName: {
    borderRadius: 1.5,
  },
});
