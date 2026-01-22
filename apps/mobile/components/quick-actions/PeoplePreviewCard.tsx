import * as React from 'react';
import { View, StyleSheet } from 'react-native';
import { useColorScheme } from 'nativewind';
import { LinearGradient } from 'expo-linear-gradient';
import { 
  Crown, UserCheck, UserSearch, Users2, 
  Handshake, Target, GraduationCap, Lightbulb,
  Star, BadgeCheck, Briefcase, MessageCircle
} from 'lucide-react-native';
import { Icon } from '@/components/ui/icon';

interface PeoplePreviewCardProps {
  peopleType: string;
  width: number;
  height: number;
}

// People preview configurations
const PEOPLE_CONFIGS: Record<string, {
  gradient: { light: [string, string]; dark: [string, string] };
  accent: { light: string; dark: string };
  secondaryAccent: { light: string; dark: string };
  icon: any;
  badgeIcon?: any;
  layout: 'profile' | 'card' | 'team' | 'network' | 'list';
}> = {
  expert: {
    gradient: { 
      light: ['#FFFBEB', '#FEF3C7'], 
      dark: ['#422006', '#2D1B06'] 
    },
    accent: { light: '#F59E0B', dark: '#FBBF24' },
    secondaryAccent: { light: '#D97706', dark: '#FCD34D' },
    icon: Crown,
    badgeIcon: Star,
    layout: 'profile',
  },
  colleague: {
    gradient: { 
      light: ['#EFF6FF', '#DBEAFE'], 
      dark: ['#1E3A5F', '#0F1D32'] 
    },
    accent: { light: '#3B82F6', dark: '#60A5FA' },
    secondaryAccent: { light: '#2563EB', dark: '#93C5FD' },
    icon: UserCheck,
    badgeIcon: Briefcase,
    layout: 'card',
  },
  contact: {
    gradient: { 
      light: ['#F0FDF4', '#DCFCE7'], 
      dark: ['#052E16', '#022C22'] 
    },
    accent: { light: '#22C55E', dark: '#4ADE80' },
    secondaryAccent: { light: '#16A34A', dark: '#86EFAC' },
    icon: UserSearch,
    badgeIcon: MessageCircle,
    layout: 'list',
  },
  team: {
    gradient: { 
      light: ['#FDF4FF', '#FAE8FF'], 
      dark: ['#2E1065', '#1E0A3E'] 
    },
    accent: { light: '#A855F7', dark: '#C084FC' },
    secondaryAccent: { light: '#7C3AED', dark: '#D8B4FE' },
    icon: Users2,
    layout: 'team',
  },
  partner: {
    gradient: { 
      light: ['#ECFEFF', '#CFFAFE'], 
      dark: ['#083344', '#042F3D'] 
    },
    accent: { light: '#06B6D4', dark: '#22D3EE' },
    secondaryAccent: { light: '#0891B2', dark: '#67E8F9' },
    icon: Handshake,
    badgeIcon: BadgeCheck,
    layout: 'network',
  },
  influencer: {
    gradient: { 
      light: ['#FFF1F2', '#FFE4E6'], 
      dark: ['#4C0519', '#2D0A12'] 
    },
    accent: { light: '#F43F5E', dark: '#FB7185' },
    secondaryAccent: { light: '#E11D48', dark: '#FDA4AF' },
    icon: Target,
    badgeIcon: Star,
    layout: 'profile',
  },
  mentor: {
    gradient: { 
      light: ['#F0FDFA', '#CCFBF1'], 
      dark: ['#042F2E', '#022825'] 
    },
    accent: { light: '#14B8A6', dark: '#2DD4BF' },
    secondaryAccent: { light: '#0D9488', dark: '#5EEAD4' },
    icon: GraduationCap,
    badgeIcon: BadgeCheck,
    layout: 'card',
  },
  advisor: {
    gradient: { 
      light: ['#FFF7ED', '#FFEDD5'], 
      dark: ['#431407', '#2D1608'] 
    },
    accent: { light: '#F97316', dark: '#FB923C' },
    secondaryAccent: { light: '#EA580C', dark: '#FDBA74' },
    icon: Lightbulb,
    badgeIcon: Star,
    layout: 'card',
  },
};

export const PeoplePreviewCard = React.memo(function PeoplePreviewCard({
  peopleType,
  width,
  height,
}: PeoplePreviewCardProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  const config = PEOPLE_CONFIGS[peopleType] || PEOPLE_CONFIGS.colleague;
  const gradient: [string, string] = isDark ? config.gradient.dark : config.gradient.light;
  const accent = isDark ? config.accent.dark : config.accent.light;
  const secondaryAccent = isDark ? config.secondaryAccent.dark : config.secondaryAccent.light;
  
  const lineColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';
  const textColor = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)';
  const subtleColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const avatarBg = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)';
  
  const padding = width * 0.1;

  const renderAvatar = (size: number, highlighted: boolean = false, showBadge: boolean = false) => (
    <View style={[styles.avatarContainer, { width: size, height: size }]}>
      <View 
        style={[
          styles.avatar, 
          { 
            width: size, 
            height: size, 
            borderRadius: size / 2,
            backgroundColor: highlighted ? `${accent}30` : avatarBg,
            borderColor: highlighted ? accent : lineColor,
            borderWidth: highlighted ? 2 : 1,
          }
        ]}
      >
        <View 
          style={[
            styles.avatarInner, 
            { 
              backgroundColor: highlighted ? accent : textColor,
              width: size * 0.4,
              height: size * 0.4,
              borderRadius: size * 0.2,
            }
          ]} 
        />
      </View>
      {showBadge && config.badgeIcon && (
        <View 
          style={[
            styles.avatarBadge, 
            { 
              backgroundColor: accent,
              width: size * 0.35,
              height: size * 0.35,
              borderRadius: size * 0.175,
              right: -2,
              bottom: -2,
            }
          ]}
        >
          <Icon as={config.badgeIcon} size={size * 0.2} color={isDark ? '#000' : '#fff'} strokeWidth={2.5} />
        </View>
      )}
    </View>
  );

  const renderLayout = () => {
    switch (config.layout) {
      case 'profile':
        return (
          <View style={styles.layoutContainer}>
            {/* Profile header */}
            <View style={styles.profileHeader}>
              {renderAvatar(40, true, true)}
              <View style={[styles.statusDot, { backgroundColor: accent }]} />
            </View>
            {/* Profile info */}
            <View style={styles.profileInfo}>
              <View style={[styles.profileName, { backgroundColor: accent, opacity: 0.8 }]} />
              <View style={[styles.profileTitle, { backgroundColor: textColor }]} />
            </View>
            {/* Stats row */}
            <View style={[styles.profileStats, { backgroundColor: subtleColor }]}>
              {[0, 1, 2].map((i) => (
                <View key={i} style={styles.statItem}>
                  <View style={[styles.statNumber, { backgroundColor: i === 0 ? accent : secondaryAccent, opacity: i === 0 ? 0.7 : 0.4 }]} />
                  <View style={[styles.statLabel, { backgroundColor: textColor }]} />
                </View>
              ))}
            </View>
            {/* Tags */}
            <View style={styles.profileTags}>
              {[0, 1].map((i) => (
                <View key={i} style={[styles.tag, { backgroundColor: i === 0 ? `${accent}20` : subtleColor, borderColor: i === 0 ? accent : lineColor }]}>
                  <View style={[styles.tagText, { backgroundColor: i === 0 ? accent : textColor, opacity: i === 0 ? 0.7 : 1 }]} />
                </View>
              ))}
            </View>
          </View>
        );

      case 'card':
        return (
          <View style={styles.layoutContainer}>
            {/* Contact card */}
            <View style={[styles.contactCard, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.8)', borderColor: lineColor }]}>
              <View style={styles.cardHeader}>
                {renderAvatar(32, true, true)}
                <View style={styles.cardInfo}>
                  <View style={[styles.cardName, { backgroundColor: accent, opacity: 0.7 }]} />
                  <View style={[styles.cardRole, { backgroundColor: textColor }]} />
                </View>
              </View>
              <View style={[styles.cardDivider, { backgroundColor: lineColor }]} />
              <View style={styles.cardDetails}>
                <View style={styles.detailRow}>
                  <View style={[styles.detailIcon, { backgroundColor: subtleColor }]} />
                  <View style={[styles.detailText, { backgroundColor: textColor, width: '70%' }]} />
                </View>
                <View style={styles.detailRow}>
                  <View style={[styles.detailIcon, { backgroundColor: subtleColor }]} />
                  <View style={[styles.detailText, { backgroundColor: textColor, width: '55%' }]} />
                </View>
              </View>
            </View>
            {/* Action button */}
            <View style={[styles.cardAction, { backgroundColor: accent }]}>
              <View style={[styles.actionText, { backgroundColor: isDark ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.5)' }]} />
            </View>
          </View>
        );

      case 'team':
        return (
          <View style={styles.layoutContainer}>
            {/* Team header */}
            <View style={[styles.teamHeader, { backgroundColor: `${accent}15` }]}>
              <Icon as={config.icon} size={12} color={accent} strokeWidth={2} />
              <View style={[styles.teamTitle, { backgroundColor: accent, opacity: 0.7 }]} />
            </View>
            {/* Team members grid */}
            <View style={styles.teamGrid}>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <View key={i} style={styles.teamMember}>
                  {renderAvatar(22, i < 2, false)}
                </View>
              ))}
            </View>
            {/* Team info */}
            <View style={styles.teamInfo}>
              <View style={[styles.teamCount, { backgroundColor: secondaryAccent, opacity: 0.5 }]} />
              <View style={[styles.teamLabel, { backgroundColor: textColor }]} />
            </View>
          </View>
        );

      case 'network':
        return (
          <View style={styles.layoutContainer}>
            {/* Network visualization */}
            <View style={styles.networkContainer}>
              {/* Central node */}
              <View style={styles.networkCenter}>
                {renderAvatar(28, true, true)}
              </View>
              {/* Connection lines */}
              <View style={[styles.connectionLine, styles.connectionTopLeft, { backgroundColor: `${accent}40` }]} />
              <View style={[styles.connectionLine, styles.connectionTopRight, { backgroundColor: `${accent}40` }]} />
              <View style={[styles.connectionLine, styles.connectionBottomLeft, { backgroundColor: `${accent}40` }]} />
              <View style={[styles.connectionLine, styles.connectionBottomRight, { backgroundColor: `${accent}40` }]} />
              {/* Connected nodes */}
              <View style={[styles.networkNode, styles.nodeTopLeft]}>
                {renderAvatar(18, false, false)}
              </View>
              <View style={[styles.networkNode, styles.nodeTopRight]}>
                {renderAvatar(18, false, false)}
              </View>
              <View style={[styles.networkNode, styles.nodeBottomLeft]}>
                {renderAvatar(16, false, false)}
              </View>
              <View style={[styles.networkNode, styles.nodeBottomRight]}>
                {renderAvatar(16, false, false)}
              </View>
            </View>
            {/* Network label */}
            <View style={styles.networkLabel}>
              <View style={[styles.networkCount, { backgroundColor: accent, opacity: 0.6 }]} />
              <View style={[styles.networkText, { backgroundColor: textColor }]} />
            </View>
          </View>
        );

      case 'list':
        return (
          <View style={styles.layoutContainer}>
            {/* Search bar */}
            <View style={[styles.searchBar, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.8)', borderColor: lineColor }]}>
              <Icon as={UserSearch} size={10} color={accent} strokeWidth={2} />
              <View style={[styles.searchText, { backgroundColor: textColor }]} />
            </View>
            {/* Contact list */}
            {[0, 1, 2].map((i) => (
              <View key={i} style={[styles.listItem, { backgroundColor: i === 0 ? `${accent}10` : 'transparent' }]}>
                {renderAvatar(20, i === 0, false)}
                <View style={styles.listInfo}>
                  <View style={[styles.listName, { backgroundColor: i === 0 ? accent : textColor, opacity: i === 0 ? 0.7 : 1 }]} />
                  <View style={[styles.listMeta, { backgroundColor: subtleColor, width: `${60 - i * 10}%` }]} />
                </View>
                {i === 0 && (
                  <View style={[styles.listBadge, { backgroundColor: accent }]} />
                )}
              </View>
            ))}
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

  // Avatar
  avatarContainer: {
    position: 'relative',
  },
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInner: {
    opacity: 0.8,
  },
  avatarBadge: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Profile layout
  profileHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  profileInfo: {
    marginTop: 8,
    gap: 4,
  },
  profileName: {
    width: '70%',
    height: 5,
    borderRadius: 2,
  },
  profileTitle: {
    width: '50%',
    height: 3,
    borderRadius: 1.5,
  },
  profileStats: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 6,
    borderRadius: 6,
    marginTop: 8,
  },
  statItem: {
    alignItems: 'center',
    gap: 2,
  },
  statNumber: {
    width: 16,
    height: 4,
    borderRadius: 2,
  },
  statLabel: {
    width: 20,
    height: 2,
    borderRadius: 1,
  },
  profileTags: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 8,
  },
  tag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1,
  },
  tagText: {
    width: 24,
    height: 3,
    borderRadius: 1.5,
  },

  // Card layout
  contactCard: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    padding: 8,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cardInfo: {
    flex: 1,
    gap: 3,
  },
  cardName: {
    width: '70%',
    height: 4,
    borderRadius: 2,
  },
  cardRole: {
    width: '50%',
    height: 3,
    borderRadius: 1.5,
  },
  cardDivider: {
    height: 1,
    marginVertical: 8,
  },
  cardDetails: {
    gap: 6,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  detailIcon: {
    width: 14,
    height: 14,
    borderRadius: 4,
  },
  detailText: {
    height: 3,
    borderRadius: 1.5,
  },
  cardAction: {
    marginTop: 8,
    paddingVertical: 6,
    borderRadius: 6,
    alignItems: 'center',
  },
  actionText: {
    width: 40,
    height: 3,
    borderRadius: 1.5,
  },

  // Team layout
  teamHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    marginBottom: 10,
  },
  teamTitle: {
    width: 40,
    height: 4,
    borderRadius: 2,
  },
  teamGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
  },
  teamMember: {
    alignItems: 'center',
  },
  teamInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 10,
  },
  teamCount: {
    width: 16,
    height: 4,
    borderRadius: 2,
  },
  teamLabel: {
    width: 30,
    height: 3,
    borderRadius: 1.5,
  },

  // Network layout
  networkContainer: {
    flex: 1,
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  networkCenter: {
    position: 'absolute',
    zIndex: 2,
  },
  connectionLine: {
    position: 'absolute',
    width: 2,
    height: 25,
    borderRadius: 1,
  },
  connectionTopLeft: {
    transform: [{ rotate: '-45deg' }],
    top: '20%',
    left: '25%',
  },
  connectionTopRight: {
    transform: [{ rotate: '45deg' }],
    top: '20%',
    right: '25%',
  },
  connectionBottomLeft: {
    transform: [{ rotate: '45deg' }],
    bottom: '25%',
    left: '25%',
  },
  connectionBottomRight: {
    transform: [{ rotate: '-45deg' }],
    bottom: '25%',
    right: '25%',
  },
  networkNode: {
    position: 'absolute',
  },
  nodeTopLeft: {
    top: '5%',
    left: '10%',
  },
  nodeTopRight: {
    top: '5%',
    right: '10%',
  },
  nodeBottomLeft: {
    bottom: '10%',
    left: '15%',
  },
  nodeBottomRight: {
    bottom: '10%',
    right: '15%',
  },
  networkLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  networkCount: {
    width: 14,
    height: 4,
    borderRadius: 2,
  },
  networkText: {
    width: 35,
    height: 3,
    borderRadius: 1.5,
  },

  // List layout
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
    flex: 1,
    height: 3,
    borderRadius: 1.5,
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderRadius: 6,
    marginBottom: 4,
    gap: 8,
  },
  listInfo: {
    flex: 1,
    gap: 3,
  },
  listName: {
    width: '60%',
    height: 3,
    borderRadius: 1.5,
  },
  listMeta: {
    height: 2,
    borderRadius: 1,
  },
  listBadge: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
