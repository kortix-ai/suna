import * as React from 'react';
import { View, StyleSheet } from 'react-native';
import { useColorScheme } from 'nativewind';
import { LinearGradient } from 'expo-linear-gradient';

interface DataPreviewCardProps {
  dataType: string;
  width: number;
  height: number;
}

// Data preview configurations
const DATA_CONFIGS: Record<string, {
  gradient: { light: [string, string]; dark: [string, string] };
  accent: { light: string; dark: string };
  secondaryAccent: { light: string; dark: string };
  layout: 'bar' | 'table' | 'pie' | 'line' | 'stats' | 'compare' | 'trend' | 'summary';
}> = {
  chart: {
    gradient: { 
      light: ['#EEF2FF', '#E0E7FF'], 
      dark: ['#1E1B4B', '#0F0A2E'] 
    },
    accent: { light: '#6366F1', dark: '#818CF8' },
    secondaryAccent: { light: '#4F46E5', dark: '#A5B4FC' },
    layout: 'bar',
  },
  table: {
    gradient: { 
      light: ['#F0FDF4', '#DCFCE7'], 
      dark: ['#052E16', '#022C22'] 
    },
    accent: { light: '#22C55E', dark: '#4ADE80' },
    secondaryAccent: { light: '#16A34A', dark: '#86EFAC' },
    layout: 'table',
  },
  'pie-chart': {
    gradient: { 
      light: ['#FDF4FF', '#FAE8FF'], 
      dark: ['#2E1065', '#1E0A3E'] 
    },
    accent: { light: '#D946EF', dark: '#E879F9' },
    secondaryAccent: { light: '#A855F7', dark: '#C084FC' },
    layout: 'pie',
  },
  'line-graph': {
    gradient: { 
      light: ['#ECFEFF', '#CFFAFE'], 
      dark: ['#083344', '#042F3D'] 
    },
    accent: { light: '#06B6D4', dark: '#22D3EE' },
    secondaryAccent: { light: '#0891B2', dark: '#67E8F9' },
    layout: 'line',
  },
  statistics: {
    gradient: { 
      light: ['#FFF7ED', '#FFEDD5'], 
      dark: ['#431407', '#2D1608'] 
    },
    accent: { light: '#F97316', dark: '#FB923C' },
    secondaryAccent: { light: '#EA580C', dark: '#FDBA74' },
    layout: 'stats',
  },
  comparison: {
    gradient: { 
      light: ['#FEF2F2', '#FEE2E2'], 
      dark: ['#450A0A', '#2D0808'] 
    },
    accent: { light: '#EF4444', dark: '#F87171' },
    secondaryAccent: { light: '#3B82F6', dark: '#60A5FA' },
    layout: 'compare',
  },
  trends: {
    gradient: { 
      light: ['#F0FDFA', '#CCFBF1'], 
      dark: ['#042F2E', '#022825'] 
    },
    accent: { light: '#14B8A6', dark: '#2DD4BF' },
    secondaryAccent: { light: '#0D9488', dark: '#5EEAD4' },
    layout: 'trend',
  },
  summary: {
    gradient: { 
      light: ['#FEFCE8', '#FEF9C3'], 
      dark: ['#422006', '#2D1B06'] 
    },
    accent: { light: '#EAB308', dark: '#FACC15' },
    secondaryAccent: { light: '#CA8A04', dark: '#FDE047' },
    layout: 'summary',
  },
};

export const DataPreviewCard = React.memo(function DataPreviewCard({
  dataType,
  width,
  height,
}: DataPreviewCardProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  const config = DATA_CONFIGS[dataType] || DATA_CONFIGS.chart;
  const gradient: [string, string] = isDark ? config.gradient.dark : config.gradient.light;
  const accent = isDark ? config.accent.dark : config.accent.light;
  const secondaryAccent = isDark ? config.secondaryAccent.dark : config.secondaryAccent.light;
  
  const lineColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';
  const textColor = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)';
  const subtleColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  
  const padding = width * 0.1;

  const renderLayout = () => {
    switch (config.layout) {
      case 'bar':
        return (
          <View style={styles.layoutContainer}>
            {/* Y-axis labels */}
            <View style={styles.yAxis}>
              {[0, 1, 2].map((i) => (
                <View key={i} style={[styles.yLabel, { backgroundColor: textColor }]} />
              ))}
            </View>
            {/* Bar chart */}
            <View style={styles.barChart}>
              {[65, 85, 45, 70, 90, 55].map((h, i) => (
                <View key={i} style={styles.barContainer}>
                  <View 
                    style={[
                      styles.bar, 
                      { 
                        height: `${h}%`,
                        backgroundColor: i === 4 ? accent : i === 1 ? secondaryAccent : `${accent}60`,
                      }
                    ]} 
                  />
                </View>
              ))}
            </View>
            {/* X-axis */}
            <View style={[styles.xAxis, { borderTopColor: lineColor }]}>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <View key={i} style={[styles.xLabel, { backgroundColor: textColor }]} />
              ))}
            </View>
          </View>
        );

      case 'table':
        return (
          <View style={styles.layoutContainer}>
            {/* Table header */}
            <View style={[styles.tableHeader, { backgroundColor: `${accent}20` }]}>
              {[0, 1, 2].map((i) => (
                <View key={i} style={[styles.tableHeaderCell, { backgroundColor: accent, opacity: 0.7 }]} />
              ))}
            </View>
            {/* Table rows */}
            {[0, 1, 2, 3].map((row) => (
              <View key={row} style={[styles.tableRow, { backgroundColor: row % 2 === 0 ? 'transparent' : subtleColor }]}>
                {[0, 1, 2].map((col) => (
                  <View 
                    key={col} 
                    style={[
                      styles.tableCell, 
                      { 
                        backgroundColor: col === 0 ? secondaryAccent : textColor,
                        opacity: col === 0 ? 0.5 : 1,
                        width: col === 0 ? '60%' : `${40 + row * 5}%`,
                      }
                    ]} 
                  />
                ))}
              </View>
            ))}
          </View>
        );

      case 'pie':
        return (
          <View style={styles.layoutContainer}>
            <View style={styles.pieContainer}>
              {/* Pie chart segments */}
              <View style={[styles.pieChart, { borderColor: lineColor }]}>
                <View style={[styles.pieSegment1, { backgroundColor: accent }]} />
                <View style={[styles.pieSegment2, { backgroundColor: secondaryAccent }]} />
                <View style={[styles.pieSegment3, { backgroundColor: `${accent}50` }]} />
                <View style={[styles.pieCenter, { backgroundColor: isDark ? gradient[0] : gradient[1] }]} />
              </View>
              {/* Legend */}
              <View style={styles.pieLegend}>
                {[accent, secondaryAccent, `${accent}50`].map((color, i) => (
                  <View key={i} style={styles.legendItem}>
                    <View style={[styles.legendDot, { backgroundColor: color }]} />
                    <View style={[styles.legendText, { backgroundColor: textColor, width: 20 + i * 5 }]} />
                  </View>
                ))}
              </View>
            </View>
          </View>
        );

      case 'line':
        return (
          <View style={styles.layoutContainer}>
            {/* Grid lines */}
            <View style={styles.lineChartGrid}>
              {[0, 1, 2, 3].map((i) => (
                <View key={i} style={[styles.gridLine, { backgroundColor: lineColor }]} />
              ))}
            </View>
            {/* Line chart path visualization */}
            <View style={styles.lineChartArea}>
              <View style={[styles.linePoint, { backgroundColor: accent, left: '5%', bottom: '20%' }]} />
              <View style={[styles.linePoint, { backgroundColor: accent, left: '20%', bottom: '45%' }]} />
              <View style={[styles.linePoint, { backgroundColor: accent, left: '35%', bottom: '35%' }]} />
              <View style={[styles.linePoint, { backgroundColor: accent, left: '50%', bottom: '65%' }]} />
              <View style={[styles.linePoint, { backgroundColor: accent, left: '65%', bottom: '55%' }]} />
              <View style={[styles.linePoint, { backgroundColor: accent, left: '80%', bottom: '80%' }]} />
              {/* Area fill */}
              <View style={[styles.areaFill, { backgroundColor: `${accent}20` }]} />
            </View>
            {/* X-axis labels */}
            <View style={styles.lineXAxis}>
              {[0, 1, 2, 3, 4].map((i) => (
                <View key={i} style={[styles.lineXLabel, { backgroundColor: textColor }]} />
              ))}
            </View>
          </View>
        );

      case 'stats':
        return (
          <View style={styles.layoutContainer}>
            {/* Stats cards */}
            <View style={styles.statsGrid}>
              {[
                { value: '89%', highlight: true },
                { value: '2.4k', highlight: false },
                { value: '+12', highlight: true },
                { value: '156', highlight: false },
              ].map((stat, i) => (
                <View 
                  key={i} 
                  style={[
                    styles.statCard, 
                    { 
                      backgroundColor: stat.highlight ? `${accent}15` : subtleColor,
                      borderColor: stat.highlight ? accent : lineColor,
                    }
                  ]}
                >
                  <View style={[styles.statValue, { backgroundColor: stat.highlight ? accent : textColor, opacity: stat.highlight ? 0.8 : 1 }]} />
                  <View style={[styles.statLabel, { backgroundColor: textColor, width: '60%' }]} />
                </View>
              ))}
            </View>
            {/* Mini trend line */}
            <View style={[styles.miniTrend, { backgroundColor: subtleColor }]}>
              <View style={[styles.trendLine, { backgroundColor: accent }]} />
            </View>
          </View>
        );

      case 'compare':
        return (
          <View style={styles.layoutContainer}>
            {/* Comparison header */}
            <View style={styles.compareHeader}>
              <View style={[styles.compareLabel, { backgroundColor: accent }]} />
              <View style={[styles.vsLabel, { backgroundColor: textColor }]} />
              <View style={[styles.compareLabel, { backgroundColor: secondaryAccent }]} />
            </View>
            {/* Comparison bars */}
            {[75, 60, 85, 45].map((value, i) => (
              <View key={i} style={styles.compareRow}>
                <View style={[styles.compareBarLeft, { width: `${value}%`, backgroundColor: accent, opacity: 0.7 }]} />
                <View style={[styles.compareDivider, { backgroundColor: lineColor }]} />
                <View style={[styles.compareBarRight, { width: `${100 - value + 10}%`, backgroundColor: secondaryAccent, opacity: 0.7 }]} />
              </View>
            ))}
          </View>
        );

      case 'trend':
        return (
          <View style={styles.layoutContainer}>
            {/* Trend indicator */}
            <View style={styles.trendHeader}>
              <View style={[styles.trendArrow, { backgroundColor: accent }]}>
                <View style={[styles.arrowUp, { borderBottomColor: isDark ? '#000' : '#fff' }]} />
              </View>
              <View style={[styles.trendPercent, { backgroundColor: accent, opacity: 0.7 }]} />
            </View>
            {/* Sparkline */}
            <View style={styles.sparklineContainer}>
              <View style={[styles.sparkline, { backgroundColor: `${accent}30` }]}>
                {[30, 45, 35, 60, 50, 75, 65, 85].map((h, i) => (
                  <View 
                    key={i} 
                    style={[
                      styles.sparkBar, 
                      { 
                        height: `${h}%`,
                        backgroundColor: i >= 6 ? accent : `${accent}60`,
                      }
                    ]} 
                  />
                ))}
              </View>
            </View>
            {/* Time labels */}
            <View style={styles.timeLabels}>
              <View style={[styles.timeLabel, { backgroundColor: textColor }]} />
              <View style={[styles.timeLabel, { backgroundColor: secondaryAccent, opacity: 0.5 }]} />
            </View>
          </View>
        );

      case 'summary':
        return (
          <View style={styles.layoutContainer}>
            {/* Summary header */}
            <View style={[styles.summaryHeader, { backgroundColor: `${accent}20`, borderLeftColor: accent }]}>
              <View style={[styles.summaryTitle, { backgroundColor: accent, opacity: 0.7 }]} />
            </View>
            {/* Key metrics */}
            <View style={styles.summaryMetrics}>
              {[0, 1, 2].map((i) => (
                <View key={i} style={styles.metricRow}>
                  <View style={[styles.metricDot, { backgroundColor: i === 0 ? accent : textColor }]} />
                  <View style={[styles.metricText, { backgroundColor: textColor, width: `${70 - i * 10}%` }]} />
                  <View style={[styles.metricValue, { backgroundColor: i === 0 ? accent : secondaryAccent, opacity: i === 0 ? 0.7 : 0.4 }]} />
                </View>
              ))}
            </View>
            {/* Conclusion */}
            <View style={[styles.summaryFooter, { backgroundColor: subtleColor }]}>
              <View style={[styles.footerLine, { backgroundColor: textColor, width: '80%' }]} />
              <View style={[styles.footerLine, { backgroundColor: textColor, width: '50%', marginTop: 4 }]} />
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
  layoutContainer: {
    flex: 1,
  },

  // Bar chart
  yAxis: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 16,
    width: 12,
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  yLabel: {
    width: 8,
    height: 2,
    borderRadius: 1,
  },
  barChart: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingLeft: 16,
    paddingBottom: 16,
    gap: 4,
  },
  barContainer: {
    flex: 1,
    height: '100%',
    justifyContent: 'flex-end',
  },
  bar: {
    width: '100%',
    borderRadius: 2,
  },
  xAxis: {
    position: 'absolute',
    bottom: 0,
    left: 16,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    paddingTop: 4,
  },
  xLabel: {
    width: 6,
    height: 2,
    borderRadius: 1,
  },

  // Table
  tableHeader: {
    flexDirection: 'row',
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderRadius: 4,
    gap: 8,
    marginBottom: 4,
  },
  tableHeaderCell: {
    width: 20,
    height: 3,
    borderRadius: 1.5,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 4,
    paddingHorizontal: 6,
    gap: 8,
    borderRadius: 2,
  },
  tableCell: {
    height: 2,
    borderRadius: 1,
  },

  // Pie chart
  pieContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  pieChart: {
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  pieSegment1: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '50%',
    height: '50%',
  },
  pieSegment2: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: '50%',
    height: '100%',
  },
  pieSegment3: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: '50%',
    height: '50%',
  },
  pieCenter: {
    position: 'absolute',
    top: '25%',
    left: '25%',
    width: '50%',
    height: '50%',
    borderRadius: 100,
  },
  pieLegend: {
    flex: 1,
    gap: 6,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  legendText: {
    height: 3,
    borderRadius: 1.5,
  },

  // Line chart
  lineChartGrid: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 16,
    justifyContent: 'space-between',
  },
  gridLine: {
    height: 1,
  },
  lineChartArea: {
    flex: 1,
    position: 'relative',
    marginBottom: 16,
  },
  linePoint: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  areaFill: {
    position: 'absolute',
    bottom: 0,
    left: '5%',
    right: '15%',
    height: '50%',
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
  },
  lineXAxis: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  lineXLabel: {
    width: 10,
    height: 2,
    borderRadius: 1,
  },

  // Stats
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  statCard: {
    width: '47%',
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    gap: 4,
  },
  statValue: {
    width: '50%',
    height: 5,
    borderRadius: 2,
  },
  statLabel: {
    height: 2,
    borderRadius: 1,
  },
  miniTrend: {
    height: 20,
    borderRadius: 4,
    marginTop: 8,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  trendLine: {
    height: 2,
    width: '60%',
    borderRadius: 1,
    marginLeft: 8,
    marginBottom: 6,
  },

  // Compare
  compareHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 10,
  },
  compareLabel: {
    width: 24,
    height: 4,
    borderRadius: 2,
  },
  vsLabel: {
    width: 12,
    height: 3,
    borderRadius: 1.5,
  },
  compareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    height: 8,
  },
  compareBarLeft: {
    height: '100%',
    borderRadius: 2,
  },
  compareDivider: {
    width: 2,
    height: '100%',
    marginHorizontal: 2,
  },
  compareBarRight: {
    height: '100%',
    borderRadius: 2,
  },

  // Trend
  trendHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  trendArrow: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowUp: {
    width: 0,
    height: 0,
    borderLeftWidth: 4,
    borderRightWidth: 4,
    borderBottomWidth: 6,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  trendPercent: {
    width: 30,
    height: 5,
    borderRadius: 2,
  },
  sparklineContainer: {
    flex: 1,
  },
  sparkline: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderRadius: 4,
    padding: 4,
    gap: 3,
  },
  sparkBar: {
    flex: 1,
    borderRadius: 1,
  },
  timeLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  timeLabel: {
    width: 20,
    height: 2,
    borderRadius: 1,
  },

  // Summary
  summaryHeader: {
    padding: 6,
    borderRadius: 4,
    borderLeftWidth: 3,
    marginBottom: 8,
  },
  summaryTitle: {
    width: '60%',
    height: 4,
    borderRadius: 2,
  },
  summaryMetrics: {
    gap: 6,
  },
  metricRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  metricDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  metricText: {
    height: 2,
    borderRadius: 1,
  },
  metricValue: {
    width: 20,
    height: 3,
    borderRadius: 1.5,
    marginLeft: 'auto',
  },
  summaryFooter: {
    padding: 6,
    borderRadius: 4,
    marginTop: 8,
  },
  footerLine: {
    height: 2,
    borderRadius: 1,
  },
});
