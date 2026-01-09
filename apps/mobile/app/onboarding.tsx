import * as React from 'react';
import { View, Dimensions, ScrollView, TouchableOpacity, Image as RNImage, StyleSheet } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import {
  ArrowRight,
  Presentation,
  Search,
  BarChart3,
  FileText,
  LogOut,
  Image as ImageIcon,
  Globe,
  FolderOpen,
  Zap,
  CheckCircle2,
  Database,
} from 'lucide-react-native';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { KortixLogo } from '@/components/ui/KortixLogo';
import * as Haptics from 'expo-haptics';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  interpolate,
  Extrapolate,
  SharedValue,
  FadeIn,
  withRepeat,
  Easing,
} from 'react-native-reanimated';
import { useLanguage } from '@/contexts';
import { useAuthContext } from '@/contexts/AuthContext';
import { useAgent } from '@/contexts/AgentContext';
import { useBillingContext } from '@/contexts/BillingContext';
import { useAccountSetup } from '@/hooks/useAccountSetup';
import { useOnboarding } from '@/hooks/useOnboarding';
import { useQueryClient } from '@tanstack/react-query';
import { agentKeys } from '@/lib/agents';
import { modelKeys } from '@/lib/models';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const DRAWER_COLLAPSED_HEIGHT = 72;
const DRAWER_EXPANDED_HEIGHT = 260;

const AnimatedView = Animated.createAnimatedComponent(View);

// Actual showcase images from desktop
const LOCAL_IMAGES = {
  browser: require('@/assets/images/onboard-images/showcase-browser.png'),
  slide1: require('@/assets/images/onboard-images/showcase-slide1.png'),
  slide2: require('@/assets/images/onboard-images/showcase-slide2.png'),
  dashboard: require('@/assets/images/onboard-images/showcase-dashboard.png'),
  logo: require('@/assets/images/onboard-images/showcase-logo.png'),
  mockup: require('@/assets/images/onboard-images/showcase-mockup.png'),
  userImage: require('@/assets/images/onboard-images/user-image-1.png'),
  userImageStylized: require('@/assets/images/onboard-images/user-image-stylized.png'),
};

// Types
type ViewType = 'terminal' | 'files' | 'browser';
type IconType = 'presentation' | 'chart' | 'file' | 'search' | 'image' | 'database';
type ContentType = 'empty' | 'image' | 'files' | 'table' | 'search' | 'markdown';

interface Step {
  type: 'message' | 'toolcall';
  aiText?: string;
  title?: string;
  view?: ViewType;
  icon?: IconType;
  contentType?: ContentType;
  contentImage?: keyof typeof LOCAL_IMAGES;
  keepContent?: boolean;
}

interface ExampleShowcase {
  id: string;
  title: string;
  description: string;
  userMessage: string;
  userImage?: keyof typeof LOCAL_IMAGES;
  steps: Step[];
}

// Function to get showcases with translations
const getExampleShowcases = (t: (key: string) => string, useEasterEgg: boolean): ExampleShowcase[] => [
  {
    id: 'slides',
    title: t('onboarding.examples.presentations.title'),
    description: t('onboarding.examples.presentations.description'),
    userMessage: t('onboarding.examples.presentations.userMessage'),
    steps: [
      {
        type: 'message',
        aiText: t('onboarding.examples.presentations.aiMessage'),
      },
      {
        type: 'toolcall',
        title: t('onboarding.examples.presentations.researching'),
        view: 'browser',
        icon: 'search',
        contentType: 'image',
        contentImage: 'browser',
      },
      {
        type: 'toolcall',
        title: t('onboarding.examples.presentations.creatingFile'),
        view: 'files',
        icon: 'file',
        contentType: 'files',
      },
      {
        type: 'toolcall',
        title: t('onboarding.examples.presentations.creatingSlides'),
        view: 'terminal',
        icon: 'presentation',
        contentType: 'image',
        contentImage: 'slide2',
      },
    ],
  },
  {
    id: 'data',
    title: t('onboarding.examples.dataAnalysis.title'),
    description: t('onboarding.examples.dataAnalysis.description'),
    userMessage: t('onboarding.examples.dataAnalysis.userMessage'),
    steps: [
      {
        type: 'message',
        aiText: t('onboarding.examples.dataAnalysis.aiMessage'),
      },
      {
        type: 'toolcall',
        title: t('onboarding.examples.dataAnalysis.loadingFromDrive'),
        view: 'browser',
        icon: 'database',
        contentType: 'table',
      },
      {
        type: 'toolcall',
        title: t('onboarding.examples.dataAnalysis.creatingVisualization'),
        view: 'terminal',
        icon: 'chart',
        contentType: 'image',
        contentImage: 'dashboard',
      },
      {
        type: 'toolcall',
        title: t('onboarding.examples.dataAnalysis.researchingMarket'),
        view: 'terminal',
        icon: 'search',
        keepContent: true,
      },
      {
        type: 'toolcall',
        title: t('onboarding.examples.dataAnalysis.creatingReport'),
        view: 'terminal',
        icon: 'file',
        contentType: 'markdown',
      },
    ],
  },
  // 50/50 chance between logo flow and easter egg image stylization
  useEasterEgg
    ? {
      id: 'image',
      title: t('onboarding.examples.imageEasterEgg.title'),
      description: t('onboarding.examples.imageEasterEgg.description'),
      userMessage: t('onboarding.examples.imageEasterEgg.userMessage'),
      userImage: 'userImage',
      steps: [
        {
          type: 'message',
          aiText: t('onboarding.examples.imageEasterEgg.aiMessage'),
        },
        {
          type: 'toolcall',
          title: t('onboarding.examples.imageEasterEgg.creatingImage'),
          view: 'terminal',
          icon: 'image',
          contentType: 'image',
          contentImage: 'userImageStylized',
        },
      ],
    }
    : {
      id: 'image',
      title: t('onboarding.examples.image.title'),
      description: t('onboarding.examples.image.description'),
      userMessage: t('onboarding.examples.image.userMessage'),
      steps: [
        {
          type: 'message',
          aiText: t('onboarding.examples.image.aiMessage'),
        },
        {
          type: 'toolcall',
          title: t('onboarding.examples.image.researchingBrand'),
          view: 'browser',
          icon: 'search',
          contentType: 'search',
        },
        {
          type: 'toolcall',
          title: t('onboarding.examples.image.creatingLogo'),
          view: 'terminal',
          icon: 'image',
          contentType: 'image',
          contentImage: 'logo',
        },
        {
          type: 'toolcall',
          title: t('onboarding.examples.image.creatingBrandBoard'),
          view: 'terminal',
          icon: 'presentation',
          contentType: 'image',
          contentImage: 'mockup',
        },
      ],
    },
];

const getIconComponent = (iconType?: IconType) => {
  switch (iconType) {
    case 'presentation': return Presentation;
    case 'chart': return BarChart3;
    case 'file': return FileText;
    case 'search': return Search;
    case 'image': return ImageIcon;
    case 'database': return Database;
    default: return Zap;
  }
};

const getViewIcon = (view: ViewType) => {
  switch (view) {
    case 'browser': return Globe;
    case 'files': return FolderOpen;
    default: return Zap;
  }
};

const VIEW_TABS: ViewType[] = ['terminal', 'files', 'browser'];

export default function OnboardingScreen() {
  const router = useRouter();
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { signOut, isSigningOut } = useAuthContext();
  const { loadAgents } = useAgent();
  const { refetchAll: refetchBilling } = useBillingContext();
  const { markSetupComplete } = useAccountSetup();
  const { markAsCompleted } = useOnboarding();
  const queryClient = useQueryClient();

  const [currentExample, setCurrentExample] = React.useState(0);
  const [useEasterEgg, setUseEasterEgg] = React.useState(Math.random() < 0.3);
  const scrollX = useSharedValue(0);
  const scrollViewRef = React.useRef<ScrollView>(null);

  // 30% chance for easter egg, 70% for logo flow
  React.useEffect(() => {
    if (currentExample === 2) { // Image example (3rd one, index 2)
      setUseEasterEgg(Math.random() < 0.3);
    }
  }, [currentExample]);

  const exampleShowcases = React.useMemo(() => getExampleShowcases(t, useEasterEgg), [t, useEasterEgg]);
  const totalExamples = exampleShowcases.length;
  const isDark = colorScheme === 'dark';

  const handleComplete = React.useCallback(async () => {
    try {
      await markAsCompleted();
      await markSetupComplete();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      refetchBilling();
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
      queryClient.invalidateQueries({ queryKey: modelKeys.available() });
      await loadAgents();
      router.replace('/home');
    } catch (error) {
      console.error('Failed to complete onboarding:', error);
      router.replace('/home');
    }
  }, [loadAgents, refetchBilling, queryClient, router, markSetupComplete, markAsCompleted]);

  const handleLogout = React.useCallback(async () => {
    if (isSigningOut) return;
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await signOut();
    } catch (error) {
      console.error('Logout error:', error);
    }
  }, [signOut, isSigningOut]);

  const handleNext = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (currentExample < totalExamples - 1) {
      const nextExample = currentExample + 1;
      setCurrentExample(nextExample);
      scrollViewRef.current?.scrollTo({
        x: nextExample * SCREEN_WIDTH,
        animated: true,
      });
    } else {
      handleComplete();
    }
  };

  const handleScroll = (event: any) => {
    const offsetX = event.nativeEvent.contentOffset.x;
    scrollX.value = offsetX;
    const newExample = Math.round(offsetX / SCREEN_WIDTH);
    if (newExample !== currentExample) {
      setCurrentExample(newExample);
    }
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-background">
        {/* Header */}
        <View className="pt-14 px-6 pb-2 flex-row justify-between items-center">
          <KortixLogo variant="logomark" size={14} color={isDark ? 'dark' : 'light'} />
          <TouchableOpacity
            onPress={handleLogout}
            disabled={isSigningOut}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Icon
              as={LogOut}
              size={20}
              className={isSigningOut ? "text-muted-foreground/50" : "text-muted-foreground"}
            />
          </TouchableOpacity>
        </View>

        {/* Title */}
        <View className="px-6 mb-3">
          <Text className="text-[24px] font-roobert-semibold text-foreground">
            {t('onboarding.welcome')}
          </Text>
          <Text className="text-[14px] font-roobert text-muted-foreground">
            {exampleShowcases[currentExample].description}
          </Text>
        </View>

        {/* Example Cards */}
        <View className="flex-1">
          <ScrollView
            ref={scrollViewRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onScroll={handleScroll}
            scrollEventThrottle={16}
            bounces={false}
          >
            {exampleShowcases.map((example, index) => (
              <ExampleCard
                key={example.id}
                example={example}
                index={index}
                scrollX={scrollX}
                isActive={index === currentExample}
                isDark={isDark}
                t={t}
              />
            ))}
          </ScrollView>
        </View>

        {/* Bottom Controls */}
        <View className="px-6 pb-8 pt-3">
          {/* Pagination */}
          <View className="flex-row gap-2 mb-4 justify-center">
            {exampleShowcases.map((_, index) => (
              <PaginationDot key={index} index={index} scrollX={scrollX} isDark={isDark} />
            ))}
          </View>

          {/* Buttons */}
          <View className="flex-row gap-3">
            {currentExample < totalExamples - 1 && (
              <Button variant="outline" size="lg" onPress={handleComplete} className="flex-1">
                <Text className="text-foreground text-[16px] font-roobert-medium">
                  {t('onboarding.skip')}
                </Text>
              </Button>
            )}
            <Button
              variant="default"
              size="lg"
              onPress={handleNext}
              className={`flex-1 ${isDark ? 'bg-white' : 'bg-black'}`}
            >
              <Text style={{
                color: isDark ? '#000000' : '#FFFFFF',
                fontSize: 16,
                fontFamily: 'Roobert-Medium',
                marginRight: 4,
              }}>
                {currentExample === totalExamples - 1
                  ? t('onboarding.getStarted')
                  : t('onboarding.next')}
              </Text>
              <Icon
                as={ArrowRight}
                size={20}
                color={isDark ? '#000000' : '#FFFFFF'}
                strokeWidth={2.5}
              />
            </Button>
          </View>
        </View>
      </View>
    </>
  );
}

// Mock Content Components
function FilesContent() {
  const files = [
    { name: 'downloads', type: 'folder' },
    { name: 'notes.md', type: 'file' },
    { name: 'data.csv', type: 'file' },
    { name: 'projects', type: 'folder' },
    { name: 'research.txt', type: 'file' },
    { name: 'documents', type: 'folder' },
    { name: 'report.pdf', type: 'file' },
    { name: 'images', type: 'folder' },
    { name: 'neural_networks.pptx', type: 'file' },
  ];

  return (
    <View className="flex-1 p-2">
      <View className="flex-row flex-wrap gap-2">
        {files.map((file, idx) => (
          <View
            key={idx}
            className={`w-[30%] p-2 rounded-lg items-center ${idx === files.length - 1
              ? 'bg-primary/10 border border-primary/30'
              : 'bg-card'
              }`}
          >
            <Icon
              as={file.type === 'folder' ? FolderOpen : FileText}
              size={20}
              className={file.type === 'folder' ? 'text-primary' : 'text-muted-foreground'}
            />
            <Text className="text-[9px] text-foreground mt-1 text-center" numberOfLines={1}>
              {file.name}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function TableContent() {
  return (
    <View className="flex-1">
      <View className="flex-row border-b border-border bg-muted/30">
        <Text className="flex-1 text-[9px] font-roobert-medium text-foreground p-1.5">Date</Text>
        <Text className="flex-1 text-[9px] font-roobert-medium text-foreground p-1.5">Dept</Text>
        <Text className="flex-1 text-[9px] font-roobert-medium text-foreground p-1.5 text-right">Revenue</Text>
        <Text className="flex-1 text-[9px] font-roobert-medium text-foreground p-1.5 text-right">Expenses</Text>
      </View>
      {[
        ['2024-01', 'Sales', '$245k', '$89k'],
        ['2024-02', 'Sales', '$268k', '$92k'],
        ['2024-03', 'Sales', '$289k', '$95k'],
        ['2024-04', 'Sales', '$312k', '$98k'],
        ['2024-05', 'Sales', '$298k', '$101k'],
        ['2024-06', 'Sales', '$334k', '$105k'],
        ['2024-07', 'Sales', '$356k', '$108k'],
        ['2024-08', 'Sales', '$372k', '$112k'],
      ].map((row, idx) => (
        <View key={idx} className="flex-row border-b border-border last:border-b-0">
          <Text className="flex-1 text-[8px] text-foreground p-1.5">{row[0]}</Text>
          <Text className="flex-1 text-[8px] text-foreground p-1.5">{row[1]}</Text>
          <Text className="flex-1 text-[8px] text-foreground p-1.5 text-right">{row[2]}</Text>
          <Text className="flex-1 text-[8px] text-foreground p-1.5 text-right">{row[3]}</Text>
        </View>
      ))}
    </View>
  );
}

function SearchContent() {
  return (
    <View className="flex-1 p-2">
      <View className="border border-border rounded-lg p-2 mb-2 items-center">
        <View className="flex-row items-center gap-2 border border-border rounded-full px-3 py-1">
          <Icon as={Search} size={10} className="text-muted-foreground" />
          <Text className="text-[9px] text-foreground">LUXY brand identity</Text>
        </View>
      </View>
      <View className="flex-1">
        {[
          { site: 'luxy.com', title: 'LUXY - Luxury Brand Guidelines', desc: 'Premium lifestyle brand focusing on minimalist elegance and sophisticated design principles...' },
          { site: 'designtrends.com', title: 'Brand Identity Best Practices 2024', desc: 'Key trends: clean typography, bold colors, memorable logos, and cohesive visual systems...' },
          { site: 'logodesign.io', title: 'Logo Design Principles', desc: 'Creating timeless, scalable brand marks that work across all mediums and platforms...' },
          { site: 'brandguide.com', title: 'Building Strong Brand Identity', desc: 'Comprehensive guide to developing recognizable brand assets and maintaining consistency...' },
          { site: 'creative.io', title: 'Luxury Brand Aesthetics', desc: 'Exploring high-end design patterns, premium color palettes, and sophisticated typography...' },
        ].map((result, idx) => (
          <View key={idx} className="mb-2.5 pb-2.5 border-b border-border">
            <Text className="text-[7px] text-muted-foreground">{result.site}</Text>
            <Text className="text-[10px] text-primary font-roobert-medium">{result.title}</Text>
            <Text className="text-[7px] text-muted-foreground leading-relaxed">{result.desc}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function MarkdownContent() {
  return (
    <View className="flex-1 p-3">
      <Text className="text-[11px] font-roobert-semibold text-foreground mb-2">Executive Summary</Text>
      <Text className="text-[9px] font-roobert-medium text-foreground">Revenue: $6.89M (+81.6% YoY)</Text>
      <Text className="text-[9px] font-roobert-medium text-foreground mb-2">Profit Margin: 31.1%</Text>

      <Text className="text-[10px] font-roobert-semibold text-foreground mt-2 mb-1">Key Findings</Text>

      <Text className="text-[9px] font-roobert-medium text-foreground mt-1">✅ What's Working</Text>
      <Text className="text-[8px] text-muted-foreground">• Sales: $3.94M revenue, 4.5/5 satisfaction</Text>
      <Text className="text-[8px] text-muted-foreground">• Growth: Nearly doubled YoY</Text>
      <Text className="text-[8px] text-muted-foreground">• Retention: Churn decreased 18.4%</Text>
      <Text className="text-[8px] text-muted-foreground mb-1">• Customer lifetime value up 42%</Text>

      <Text className="text-[9px] font-roobert-medium text-foreground mt-1">⚠️ Critical Issues</Text>
      <Text className="text-[8px] text-muted-foreground">1. Support: 10.1% churn rate</Text>
      <Text className="text-[8px] text-muted-foreground">2. Engineering: 70% expense ratio</Text>
      <Text className="text-[8px] text-muted-foreground">3. Marketing: Diminishing ROI</Text>
      <Text className="text-[8px] text-muted-foreground mb-1">4. Product: Feature velocity declining</Text>

      <Text className="text-[9px] font-roobert-medium text-foreground mt-2 mb-1">Recommendations</Text>
      <Text className="text-[8px] font-roobert-medium text-foreground">Priority #1: Fix Support</Text>
      <Text className="text-[8px] text-muted-foreground">• Hire 5-7 specialists</Text>
      <Text className="text-[8px] text-muted-foreground">• Target: 4.5+ satisfaction by Q2</Text>
      <Text className="text-[8px] text-muted-foreground mb-1">• Implement 24/7 coverage</Text>

      <Text className="text-[8px] font-roobert-medium text-foreground mt-1">Priority #2: Optimize Costs</Text>
      <Text className="text-[8px] text-muted-foreground">• Review engineering overhead</Text>
      <Text className="text-[8px] text-muted-foreground">• Automate repetitive tasks</Text>
      <Text className="text-[8px] text-muted-foreground">• Reduce infrastructure spend by 20%</Text>
    </View>
  );
}

// View Switcher with no spring - just timing
interface ViewSwitcherProps {
  activeView: ViewType;
  isDark: boolean;
}

function ViewSwitcher({ activeView, isDark }: ViewSwitcherProps) {
  const activeIndex = VIEW_TABS.indexOf(activeView);
  const translateX = useSharedValue(activeIndex * 28);

  React.useEffect(() => {
    translateX.value = withTiming(activeIndex * 28, { duration: 150 });
  }, [activeIndex]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <View className="flex-row rounded-full border border-border p-1 relative">
      <AnimatedView
        style={[indicatorStyle, styles.indicator]}
        className="bg-primary absolute"
      />
      {VIEW_TABS.map((view) => {
        const ViewIcon = getViewIcon(view);
        const isActiveView = activeView === view;
        return (
          <View
            key={view}
            className="w-7 h-7 rounded-full items-center justify-center z-10"
          >
            <Icon
              as={ViewIcon}
              size={14}
              color={isActiveView ? (isDark ? '#000000' : '#FFFFFF') : undefined}
              className={isActiveView ? '' : 'text-foreground'}
            />
          </View>
        );
      })}
    </View>
  );
}

// Example Card
interface ExampleCardProps {
  example: ExampleShowcase;
  index: number;
  scrollX: SharedValue<number>;
  isActive: boolean;
  isDark: boolean;
  t: (key: string) => string;
}

function ExampleCard({ example, index, scrollX, isActive, isDark, t }: ExampleCardProps) {
  const [currentStep, setCurrentStep] = React.useState(0);
  const [typedText, setTypedText] = React.useState('');
  const [displayedContent, setDisplayedContent] = React.useState<Step | null>(null);
  const [animationComplete, setAnimationComplete] = React.useState(false);
  const [isDrawerExpanded, setIsDrawerExpanded] = React.useState(false);
  const [manualControl, setManualControl] = React.useState(false);
  const drawerHeight = useSharedValue(DRAWER_COLLAPSED_HEIGHT);

  const isSlowExample = example.id === 'data' || example.id === 'image';
  const STEP_DURATION = isSlowExample ? 2800 : 1800;

  React.useEffect(() => {
    if (isActive) {
      setCurrentStep(0);
      setTypedText('');
      setDisplayedContent(null);
      setAnimationComplete(false);
      setIsDrawerExpanded(false);
      setManualControl(false);
      drawerHeight.value = DRAWER_COLLAPSED_HEIGHT;
    }
  }, [isActive]);

  const hasToolCalls = example.steps.slice(0, currentStep + 1).some(s => s.type === 'toolcall');
  React.useEffect(() => {
    if (manualControl) return; // Don't auto-animate if user has manual control

    if (hasToolCalls) {
      setIsDrawerExpanded(true);
      drawerHeight.value = withTiming(DRAWER_EXPANDED_HEIGHT, { duration: 200 });
    } else {
      setIsDrawerExpanded(false);
      drawerHeight.value = withTiming(DRAWER_COLLAPSED_HEIGHT, { duration: 150 });
    }
  }, [hasToolCalls, manualControl]);

  const toggleDrawer = () => {
    if (!hasToolCalls) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setManualControl(true);
    setIsDrawerExpanded(!isDrawerExpanded);
    drawerHeight.value = withTiming(
      isDrawerExpanded ? DRAWER_COLLAPSED_HEIGHT : DRAWER_EXPANDED_HEIGHT,
      { duration: 200 }
    );
  };

  const handleToolClick = (toolIndex: number) => {
    const toolSteps = example.steps.map((s, i) => ({ step: s, index: i })).filter(({ step }) => step.type === 'toolcall');
    if (toolIndex < toolSteps.length) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const targetStepIndex = toolSteps[toolIndex].index;
      setCurrentStep(targetStepIndex);
      setAnimationComplete(false);
      setManualControl(false); // Resume auto-animation

      // Update content
      const targetStep = example.steps[targetStepIndex];
      if (targetStep.type === 'toolcall' && !targetStep.keepContent) {
        setDisplayedContent(targetStep);
      }

      // Expand drawer if collapsed
      if (!isDrawerExpanded) {
        setIsDrawerExpanded(true);
        drawerHeight.value = withTiming(DRAWER_EXPANDED_HEIGHT, { duration: 200 });
      }
    }
  };

  React.useEffect(() => {
    if (!isActive) return;
    const step = example.steps[currentStep];
    if (!step) return;

    if (step.type === 'message') {
      let charIndex = 0;
      const fullText = step.aiText || '';
      const typingInterval = setInterval(() => {
        if (charIndex <= fullText.length) {
          setTypedText(fullText.slice(0, charIndex));
          charIndex++;
        } else {
          clearInterval(typingInterval);
          setTimeout(() => {
            if (currentStep < example.steps.length - 1) {
              setCurrentStep(prev => prev + 1);
            }
          }, 300);
        }
      }, 15);
      return () => clearInterval(typingInterval);
    }

    if (step.type === 'toolcall') {
      if (!step.keepContent) {
        setDisplayedContent(step);
      }

      const timer = setTimeout(() => {
        if (currentStep < example.steps.length - 1) {
          setCurrentStep(prev => prev + 1);
        } else {
          setAnimationComplete(true);
        }
      }, STEP_DURATION);
      return () => clearTimeout(timer);
    }
  }, [currentStep, isActive, example, STEP_DURATION]);

  const cardAnimatedStyle = useAnimatedStyle(() => {
    const inputRange = [
      (index - 1) * SCREEN_WIDTH,
      index * SCREEN_WIDTH,
      (index + 1) * SCREEN_WIDTH,
    ];
    const scale = interpolate(scrollX.value, inputRange, [0.95, 1, 0.95], Extrapolate.CLAMP);
    const opacity = interpolate(scrollX.value, inputRange, [0.6, 1, 0.6], Extrapolate.CLAMP);
    return { transform: [{ scale }], opacity };
  });

  const drawerAnimatedStyle = useAnimatedStyle(() => ({
    height: drawerHeight.value,
    bottom: drawerHeight.value > DRAWER_COLLAPSED_HEIGHT ? -10 : 0,
  }));

  const currentStepData = example.steps[currentStep];
  const activeView = currentStepData?.view || 'terminal';
  const visibleToolSteps = example.steps.slice(0, currentStep + 1).filter(s => s.type === 'toolcall');

  const renderContent = () => {
    if (!displayedContent?.contentType || displayedContent.contentType === 'empty') {
      return (
        <View className="flex-1 items-center justify-center">
          <Icon as={Zap} size={24} className="text-muted-foreground opacity-30" />
          <Text className="text-[11px] text-muted-foreground mt-1">{t('onboarding.ready')}</Text>
        </View>
      );
    }

    switch (displayedContent.contentType) {
      case 'image':
        if (!displayedContent.contentImage) return null;
        const isLogoOrMockup = displayedContent.contentImage === 'logo' || displayedContent.contentImage === 'mockup';
        return isLogoOrMockup ? (
          <RNImage
            source={LOCAL_IMAGES[displayedContent.contentImage]}
            style={styles.image}
            resizeMode="contain"
          />
        ) : (
          <View style={styles.imageContainer}>
            <RNImage
              source={LOCAL_IMAGES[displayedContent.contentImage]}
              style={styles.aspectImage}
              resizeMode="cover"
            />
          </View>
        );
      case 'files':
        return <FilesContent />;
      case 'table':
        return <TableContent />;
      case 'search':
        return <SearchContent />;
      case 'markdown':
        return <MarkdownContent />;
      default:
        return null;
    }
  };

  return (
    <View style={{ width: SCREEN_WIDTH }} className="px-5 flex-1">
      <AnimatedView
        style={[cardAnimatedStyle, { overflow: 'hidden' }]}
        className="flex-1 rounded-3xl border border-border bg-card"
      >
        {/* Chat Section */}
        <View className="flex-1 p-4">
          {/* User Message */}
          <View className="mb-4">
            <View className="flex-row justify-end">
              <View
                className="max-w-[85%] px-4 py-3 border border-border bg-background"
                style={{ borderRadius: 20, borderBottomRightRadius: 6 }}
              >
                <Text className="text-[14px] font-roobert text-foreground">
                  {example.userMessage}
                </Text>
              </View>
            </View>

            {example.userImage && (
              <View className="flex-row justify-end mt-2">
                <View
                  className="max-w-[85%] border border-border bg-background overflow-hidden"
                  style={{ borderRadius: 12 }}
                >
                  <RNImage
                    source={LOCAL_IMAGES[example.userImage]}
                    style={{ width: 200, height: 150 }}
                    resizeMode="cover"
                  />
                </View>
              </View>
            )}
          </View>

          {/* AI Response */}
          <View className="flex-1">
            <View className="flex-row items-center gap-1.5 mb-2">
              <KortixLogo variant="symbol" size={14} color={isDark ? 'dark' : 'light'} />
              <Text className="text-[13px] font-roobert-medium text-foreground opacity-50">
                Kortix
              </Text>
            </View>

            {typedText.length > 0 && (
              <Text className="text-[14px] font-roobert text-foreground mb-3">
                {typedText}
                {currentStepData?.type === 'message' && typedText.length < (currentStepData.aiText?.length || 0) && (
                  <Text className="text-primary">|</Text>
                )}
              </Text>
            )}

            <View className="gap-2">
              {visibleToolSteps.map((step, idx) => {
                const IconComp = getIconComponent(step.icon);
                const isLastTool = idx === visibleToolSteps.length - 1;
                const isCurrentlyRunning = isLastTool && currentStepData?.type === 'toolcall' && !animationComplete;

                return (
                  <TouchableOpacity
                    key={idx}
                    onPress={() => handleToolClick(idx)}
                    activeOpacity={0.7}
                  >
                    <AnimatedView
                      entering={FadeIn.duration(200)}
                      className="flex-row items-center gap-2.5 px-3 py-2.5 rounded-2xl border border-border bg-background"
                    >
                      <View className="w-7 h-7 rounded-xl border border-border bg-card items-center justify-center">
                        <Icon as={IconComp} size={14} className="text-primary" />
                      </View>
                      <Text className="text-[13px] font-roobert-medium text-foreground flex-1">
                        {step.title}
                      </Text>
                      {isCurrentlyRunning ? (
                        <SpinningLoader />
                      ) : (
                        <Icon as={CheckCircle2} size={18} className="text-primary" />
                      )}
                    </AnimatedView>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </View>

        {/* Kortix Computer Drawer */}
        <AnimatedView
          style={[
            drawerAnimatedStyle,
            styles.drawer,
            { borderColor: isDark ? '#27272a' : '#e4e4e7' },
          ]}
          className="bg-background absolute left-0 right-0"
        >
          <TouchableOpacity
            onPress={toggleDrawer}
            activeOpacity={0.7}
            disabled={!hasToolCalls}
          >
            <View className="items-center pt-2.5 pb-1.5">
              <View className="w-10 h-1 rounded-full bg-border" />
            </View>

            <View className="px-4 py-2 flex-row items-center justify-between">
              <View className="flex-row items-center gap-2">
                <KortixLogo variant="symbol" size={14} color={isDark ? 'dark' : 'light'} />
                <Text className="text-[14px] font-roobert-medium text-foreground">
                  {t('onboarding.kortixComputer')}
                </Text>
              </View>

              <ViewSwitcher activeView={activeView} isDark={isDark} />
            </View>
          </TouchableOpacity>

          {/* Computer Content */}
          <View className="flex-1 mx-3 rounded-xl overflow-hidden border border-border bg-card">
            {renderContent()}
          </View>
        </AnimatedView>
      </AnimatedView>
    </View>
  );
}

const styles = StyleSheet.create({
  drawer: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderBottomWidth: 0,
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  imageContainer: {
    width: '100%',
    aspectRatio: 16 / 9,
    alignSelf: 'center',
  },
  aspectImage: {
    width: '100%',
    height: '100%',
  },
  indicator: {
    width: 28,
    height: 28,
    borderRadius: 14,
    top: 4,
    left: 4,
  },
});

function SpinningLoader() {
  return <KortixLoader size="small" customSize={16} />;
}

interface PaginationDotProps {
  index: number;
  scrollX: SharedValue<number>;
  isDark: boolean;
}

function PaginationDot({ index, scrollX, isDark }: PaginationDotProps) {
  const animatedStyle = useAnimatedStyle(() => {
    const inputRange = [
      (index - 1) * SCREEN_WIDTH,
      index * SCREEN_WIDTH,
      (index + 1) * SCREEN_WIDTH,
    ];
    const width = interpolate(scrollX.value, inputRange, [8, 24, 8], Extrapolate.CLAMP);
    const opacity = interpolate(scrollX.value, inputRange, [0.3, 1, 0.3], Extrapolate.CLAMP);
    return { width, opacity };
  });

  return (
    <AnimatedView
      style={[
        animatedStyle,
        {
          backgroundColor: isDark ? '#FFFFFF' : '#000000',
          height: 8,
          borderRadius: 4,
        },
      ]}
    />
  );
}
