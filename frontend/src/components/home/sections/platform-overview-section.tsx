'use client';

import React from 'react';
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/lib/utils';
import { SectionHeader } from '@/components/home/section-header';
import { Globe } from '@/components/magicui/globe';
import { GradientText } from '@/components/animate-ui/text/gradient';
import { 
  MessageSquare, 
  Zap, 
  BarChart3, 
  RefreshCw, 
  Shield, 
  Users,
  ArrowUpRight,
  Sparkles,
  Brain,
  TrendingUp,
  Code,
  Briefcase,
  Heart,
  Building,
  PieChart,
  LineChart,
  Target,
  ShoppingCart,
  DollarSign,
  Clock,
  Activity
} from 'lucide-react';

export function PlatformOverviewSection() {
  const features = [
    {
      title: "AI-Powered Collaboration",
      description: "Infinite capacity on demand. Get specialized AI agents for any business need, anytime.",
      skeleton: <CollaborationSkeleton />,
      className: "col-span-1 lg:col-span-4 border-b lg:border-r dark:border-neutral-800/50",
      icon: <MessageSquare className="h-5 w-5" />
    },
    {
      title: "Global Team Scale",
      description: "Deploy worldwide with enterprise-grade infrastructure and dedicated support.",
      skeleton: <GlobeSkeleton />,
      className: "border-b col-span-1 lg:col-span-2 dark:border-neutral-800/50",
      icon: <Users className="h-5 w-5" />
    },
    {
      title: "Advanced Analytics",
      description: "Transform raw data into actionable insights with real-time intelligence and reporting.",
      skeleton: <AnalyticsSkeleton />,
      className: "col-span-1 lg:col-span-3 lg:border-r dark:border-neutral-800/50",
      icon: <BarChart3 className="h-5 w-5" />
    },
    {
      title: "Smart Automation",
      description: "Automate repetitive tasks and workflows so you can focus on strategic initiatives.",
      skeleton: <AutomationSkeleton />,
      className: "col-span-1 lg:col-span-3 border-b lg:border-none dark:border-neutral-800/50",
      icon: <RefreshCw className="h-5 w-5" />
    },
  ];

  return (
    <section
      id="platform-overview"
      className="relative z-20 py-20 lg:py-32 max-w-7xl mx-auto"
    >
      <div className="px-6 lg:px-8">
        <SectionHeader>
          <div className="flex items-center justify-center gap-2 mb-4">
            <Sparkles className="h-5 w-5 text-secondary" />
            <span className="text-sm font-medium text-secondary uppercase tracking-wider">
              Platform Overview
            </span>
          </div>
          <h2 className="text-3xl lg:text-5xl lg:leading-tight max-w-4xl mx-auto text-center tracking-tight font-medium text-black dark:text-white">
            Empower Your Workflow with <GradientText text="AI" />
          </h2>
          <p className="text-base lg:text-lg max-w-2xl my-6 mx-auto text-muted-foreground text-center font-normal">
            Ask <GradientText text="Operator" /> for real-time collaboration, seamless integrations, and actionable insights to streamline your operations.
          </p>
        </SectionHeader>

        <div className="relative mt-16 lg:mt-20">
          <div className="grid grid-cols-1 lg:grid-cols-6 xl:border rounded-2xl dark:border-neutral-800/50 bg-gradient-to-br from-background to-muted/20 backdrop-blur-sm">
            {features.map((feature, index) => (
              <FeatureCard key={feature.title} className={feature.className}>
                <div className="flex items-center gap-3 mb-4">
                  <div className="p-2 bg-secondary/10 rounded-lg">
                    <div className="text-secondary">
                      {feature.icon}
                    </div>
                  </div>
                  <ArrowUpRight className="h-4 w-4 text-muted-foreground ml-auto opacity-60" />
                </div>
                <FeatureTitle>
                  {feature.title === "AI-Powered Collaboration" ? (
                    <><GradientText text="AI-Powered" /> Collaboration</>
                  ) : (
                    feature.title
                  )}
                </FeatureTitle>
                <FeatureDescription>
                  {feature.title === "AI-Powered Collaboration" ? (
                    <>Infinite capacity on demand. Get specialized <GradientText text="AI Agents" /> for any business need, anytime.</>
                  ) : (
                    feature.description
                  )}
                </FeatureDescription>
                <div className="h-full w-full flex-1 mt-6">{feature.skeleton}</div>
              </FeatureCard>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

const FeatureCard = ({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) => {
  return (
    <div className={cn(`p-6 lg:p-8 xl:p-10 relative overflow-hidden group hover:bg-muted/5 transition-all duration-300`, className)}>
      <div className="relative z-10">
        {children}
      </div>
    </div>
  );
};

const FeatureTitle = ({ children }: { children?: React.ReactNode }) => {
  return (
    <h3 className="text-xl lg:text-2xl font-semibold tracking-tight text-black dark:text-white mb-2">
      {children}
    </h3>
  );
};

const FeatureDescription = ({ children }: { children?: React.ReactNode }) => {
  return (
    <p className="text-sm lg:text-base text-muted-foreground leading-relaxed max-w-sm">
      {children}
    </p>
  );
};

const CollaborationSkeleton = () => {
  const [currentScenario, setCurrentScenario] = useState(0);
  const [showUserMessage, setShowUserMessage] = useState(false);
  const [showTyping, setShowTyping] = useState(false);
  const [showToolCalls, setShowToolCalls] = useState(false);
  const [showResponse, setShowResponse] = useState(false);

  const scenarios = [
    {
      id: 1,
      agentName: "Marketing Operator",
      user: "I need a comprehensive marketing strategy for our new product launch targeting millennials.",
      tools: [
        { name: "market_research_tool", description: "Analyzing millennial demographics and preferences", status: "running" },
        { name: "competitor_analysis_tool", description: "Scanning competitor strategies and pricing", status: "complete" },
        { name: "campaign_optimizer", description: "Generating multi-channel campaign strategy", status: "running" }
      ],
      ai: "I'll create a multi-channel strategy: Instagram/TikTok campaigns, influencer partnerships, and data-driven content. Expected ROI: 340% with 2M+ reach in 90 days."
    },
    {
      id: 2,
      agentName: "Analytics Operator",
      user: "Our customer churn rate is increasing. Can you analyze the data and provide actionable insights?",
      tools: [
        { name: "data_analyzer", description: "Processing customer behavior data", status: "complete" },
        { name: "churn_predictor", description: "Identifying high-risk customer segments", status: "running" },
        { name: "retention_optimizer", description: "Generating retention strategies", status: "running" }
      ],
      ai: "Analysis complete: 23% churn driven by pricing sensitivity and poor onboarding. Recommending tiered pricing model and enhanced 30-day experience journey."
    },
    {
      id: 3,
      agentName: "Tech Operator",
      user: "We need to scale our platform to handle 10x more traffic. What's the best architecture approach?",
      tools: [
        { name: "infrastructure_analyzer", description: "Analyzing current system architecture", status: "complete" },
        { name: "load_testing_tool", description: "Simulating 10x traffic scenarios", status: "running" },
        { name: "architecture_optimizer", description: "Designing scalable infrastructure", status: "running" }
      ],
      ai: "Implementing microservices with Kubernetes, Redis caching, and CDN optimization. This architecture will handle 50M+ requests/day with 99.9% uptime."
    },
    {
      id: 4,
      agentName: "Operations Operator",
      user: "Our supply chain is experiencing delays. Can you optimize our procurement process?",
      tools: [
        { name: "supply_chain_analyzer", description: "Mapping current supply chain bottlenecks", status: "complete" },
        { name: "vendor_optimizer", description: "Evaluating alternative suppliers", status: "running" },
        { name: "procurement_automator", description: "Designing automated workflows", status: "running" }
      ],
      ai: "Identified 3 bottlenecks and 12 suppliers. Implementing automated procurement system will reduce lead times by 40% and costs by 15%."
    },
    {
      id: 5,
      agentName: "Finance Operator",
      user: "I need a detailed financial projection for the next 5 years including risk analysis.",
      tools: [
        { name: "financial_modeler", description: "Building 5-year revenue projections", status: "running" },
        { name: "risk_analyzer", description: "Identifying market and operational risks", status: "complete" },
        { name: "scenario_simulator", description: "Running Monte Carlo simulations", status: "running" }
      ],
      ai: "Generated comprehensive model: 28% revenue growth, 15% margin expansion. Key risks: market volatility (12%) and regulatory changes (8%). Mitigation strategies included."
    },
    {
      id: 6,
      agentName: "People Operator",
      user: "We're scaling rapidly and need to optimize our hiring process while maintaining culture fit.",
      tools: [
        { name: "recruitment_optimizer", description: "Analyzing current hiring pipeline", status: "complete" },
        { name: "culture_matcher", description: "Building culture assessment framework", status: "running" },
        { name: "automation_builder", description: "Creating automated screening process", status: "running" }
      ],
      ai: "Designed AI-powered recruitment pipeline: 70% faster screening, 85% culture match accuracy. Automated scheduling reduces time-to-hire by 12 days."
    }
  ];

  useEffect(() => {
    const interval = setInterval(() => {
      // Reset all states
      setShowResponse(false);
      setShowToolCalls(false);
      setShowTyping(false);
      setShowUserMessage(false);
      
      setTimeout(() => {
        // Change scenario and show user message
        setCurrentScenario((prev) => (prev + 1) % scenarios.length);
        setShowUserMessage(true);
        
        setTimeout(() => {
          // Show typing indicator after user message
          setShowTyping(true);
          
          setTimeout(() => {
            // Show tool calls after typing
            setShowTyping(false);
            setShowToolCalls(true);
            
            setTimeout(() => {
              // Show AI response after tool calls
              setShowResponse(true);
            }, 2000);
          }, 1000);
        }, 800);
      }, 300);
    }, 8000);

    // Initialize first scenario
    setShowUserMessage(true);
    setTimeout(() => {
      setShowTyping(true);
      setTimeout(() => {
        setShowTyping(false);
        setShowToolCalls(true);
        setTimeout(() => {
          setShowResponse(true);
        }, 2000);
      }, 1000);
    }, 800);

    return () => clearInterval(interval);
  }, []);

  const scenario = scenarios[currentScenario];

  return (
    <div className="relative h-[350px] overflow-hidden">
      <div className="w-full max-w-sm mx-auto h-full p-4 flex flex-col justify-center">
        <div className="space-y-3">
          {/* User Message */}
          <AnimatePresence mode="wait">
            {showUserMessage && (
              <motion.div
                key={`user-${scenario.id}`}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
                className="flex justify-end"
              >
                <div className="bg-black text-white px-3 py-2 rounded-xl max-w-[85%] text-sm">
                  {scenario.user}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* AI Response */}
          <div className="flex items-start gap-2">
            <div className="flex-1">
              {/* Agent Name */}
              <motion.div
                key={`name-${scenario.id}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3 }}
                className="text-xs text-muted-foreground mb-1 ml-1"
              >
                {scenario.agentName.replace(' Operator', '')} <GradientText text="Operator" />
              </motion.div>

              {/* Typing Indicator */}
              <AnimatePresence>
                {showTyping && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    transition={{ duration: 0.2 }}
                    className="bg-white border border-border px-3 py-2 rounded-xl mb-2"
                  >
                    <div className="flex gap-1">
                      {[0, 1, 2].map((index) => (
                        <motion.div
                          key={index}
                          className="w-2 h-2 bg-gray-400 rounded-full"
                          animate={{ y: [0, -4, 0] }}
                          transition={{
                            duration: 0.6,
                            repeat: Infinity,
                            delay: index * 0.1,
                            ease: "easeInOut",
                          }}
                        />
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Tool Calls */}
              <AnimatePresence>
                {showToolCalls && (
                  <motion.div
                    key={`tools-${scenario.id}`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.3 }}
                    className="bg-muted/30 border border-border/50 px-3 py-2 rounded-xl mb-2"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <Code className="w-3 h-3 text-secondary" />
                      <span className="text-xs font-medium text-secondary">Running tools...</span>
                    </div>
                    <div className="space-y-1">
                      {scenario.tools.map((tool, index) => (
                        <motion.div
                          key={tool.name}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: index * 0.3 }}
                          className="flex items-center gap-2 text-xs"
                        >
                          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                            tool.status === 'complete' 
                              ? 'bg-green-500' 
                              : 'bg-yellow-500 animate-pulse'
                          }`} />
                          <span className="text-muted-foreground font-mono text-[10px]">{tool.name}</span>
                          <span className="text-muted-foreground/60 text-[10px] truncate">{tool.description}</span>
                        </motion.div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* AI Response */}
              <AnimatePresence>
                {showResponse && (
                  <motion.div
                    key={`response-${scenario.id}`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.3 }}
                    className="bg-white border border-border px-3 py-2 rounded-xl"
                  >
                    <p className="text-sm text-black">
                      {scenario.ai}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const GlobeSkeleton = () => {
  return (
    <div className="relative h-[320px] p-4">
      <div className="h-full flex flex-col items-center justify-center">
        <div className="relative w-full h-full max-w-[240px] max-h-[240px] flex items-center justify-center">
          <Globe className="w-full h-full" />
        </div>
      </div>
      <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex items-center gap-2 bg-background/80 backdrop-blur-sm rounded-full px-3 py-1 text-xs font-medium border border-border/50">
        <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
        <span className="text-muted-foreground">Global Scale</span>
      </div>
    </div>
  );
};

const AnalyticsSkeleton = () => {
  const [currentAnalytic, setCurrentAnalytic] = useState(0);
  const [showInsight, setShowInsight] = useState(false);

  const analytics = [
    {
      id: 1,
      title: "Revenue Growth",
      type: "Line Chart",
      icon: <LineChart className="w-4 h-4 text-emerald-500" />,
      color: "emerald",
      metric: "$2.4M",
      change: "+47%",
      changeType: "positive",
      insight: "Operator detected seasonal pattern: Q4 revenue jumps 73% due to holiday promotions. Recommend increasing inventory by 45% in October.",
      chart: <RevenueLineChart />,
      badge: "Revenue Operator"
    },
    {
      id: 2,
      title: "Customer Segments",
      type: "Pie Chart",
      icon: <PieChart className="w-4 h-4 text-blue-500" />,
      color: "blue",
      metric: "5 Segments",
      change: "+2 new",
      changeType: "positive",
      insight: "Enterprise clients (34%) show highest LTV. Mid-market segment growing 89% QoQ. Recommend targeting similar profiles.",
      chart: <CustomerPieChart />,
      badge: "Segment Operator"
    },
    {
      id: 3,
      title: "Conversion Funnel",
      type: "Funnel Chart",
      icon: <Target className="w-4 h-4 text-purple-500" />,
      color: "purple",
      metric: "8.4%",
      change: "+2.1%",
      changeType: "positive",
      insight: "Checkout abandonment at 67%. A/B test shows single-page checkout increases conversion by 34%. Deploy immediately.",
      chart: <ConversionFunnelChart />,
      badge: "Conversion Operator"
    },
    {
      id: 4,
      title: "Sales Performance",
      type: "Bar Chart",
      icon: <BarChart3 className="w-4 h-4 text-orange-500" />,
      color: "orange",
      metric: "$847K",
      change: "+23%",
      changeType: "positive",
      insight: "Top performer Sarah leads with $127K. Team velocity up 31%. Recommend promoting high-performers and scaling top strategies.",
      chart: <SalesBarChart />,
      badge: "Sales Operator"
    },
    {
      id: 5,
      title: "User Activity",
      type: "Heat Map",
      icon: <Activity className="w-4 h-4 text-pink-500" />,
      color: "pink",
      metric: "89% Active",
      change: "+12%",
      changeType: "positive",
      insight: "Peak usage: Tuesdays 2-4 PM. Feature adoption varies by region. European users prefer analytics, US prefers automation.",
      chart: <ActivityHeatMap />,
      badge: "Behavior Operator"
    },
    {
      id: 6,
      title: "Market Trends",
      type: "Trend Analysis",
      icon: <TrendingUp className="w-4 h-4 text-indigo-500" />,
      color: "indigo",
      metric: "↗ Bullish",
      change: "+156%",
      changeType: "positive",
      insight: "Market sentiment strongly positive. Competitor analysis shows 23% market share opportunity. Recommend aggressive expansion.",
      chart: <MarketTrendChart />,
      badge: "Market Operator"
    }
  ];

  useEffect(() => {
    const interval = setInterval(() => {
      setShowInsight(false);
      
      setTimeout(() => {
        setCurrentAnalytic((prev) => (prev + 1) % analytics.length);
        setTimeout(() => {
          setShowInsight(true);
        }, 800);
      }, 400);
    }, 6000);

    // Initialize first analytic
    setTimeout(() => {
      setShowInsight(true);
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const analytic = analytics[currentAnalytic];

  return (
    <div className="relative h-[280px] bg-gradient-to-br from-secondary/5 to-transparent rounded-xl p-4 overflow-hidden">
      {/* Live Analytics Indicator */}
      <div className="absolute top-3 right-3 flex items-center gap-1">
        <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div>
        <span className="text-xs text-muted-foreground">Live</span>
      </div>

      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 mb-3">
          <AnimatePresence mode="wait">
            <motion.div
              key={`icon-${analytic.id}`}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.3 }}
              className="p-1.5 bg-secondary/10 rounded-lg"
            >
              {analytic.icon}
            </motion.div>
          </AnimatePresence>
          <div className="flex-1">
            <AnimatePresence mode="wait">
              <motion.h4
                key={`title-${analytic.id}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
                className="text-sm font-semibold text-primary"
              >
                {analytic.title}
              </motion.h4>
            </AnimatePresence>
            <div className="text-xs text-muted-foreground">{analytic.type}</div>
          </div>
        </div>

        {/* Metrics Row */}
        <div className="flex items-center justify-between mb-3">
          <AnimatePresence mode="wait">
            <motion.div
              key={`metric-${analytic.id}`}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.3 }}
              className="text-lg font-bold text-primary"
            >
              {analytic.metric}
            </motion.div>
          </AnimatePresence>
          <div className={`text-xs font-medium px-2 py-1 rounded ${analytic.changeType === 'positive' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
            {analytic.change}
          </div>
        </div>

        {/* Chart */}
        <div className="flex-1 flex items-center justify-center min-h-[80px] mb-3">
          <AnimatePresence mode="wait">
            <motion.div
              key={`chart-${analytic.id}`}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.5 }}
              className="w-full h-full"
            >
              {analytic.chart}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* AI Insight */}
        <div className="mt-auto">
          <div className="flex items-center gap-2 mb-2">
            <Brain className="w-3 h-3 text-secondary" />
            <AnimatePresence mode="wait">
              <motion.span
                key={`badge-${analytic.id}`}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                transition={{ duration: 0.3 }}
                className="text-xs font-medium text-secondary"
              >
                {analytic.badge.replace(' Operator', '')} <GradientText text="Operator" />
              </motion.span>
            </AnimatePresence>
          </div>
          <AnimatePresence mode="wait">
            {showInsight && (
              <motion.div
                key={`insight-${analytic.id}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.5 }}
                className="bg-muted/50 backdrop-blur-sm rounded-lg p-2 border border-border/50"
              >
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {analytic.insight.split('Operator').map((part, index) => (
                    <React.Fragment key={index}>
                      {part}
                      {index < analytic.insight.split('Operator').length - 1 && <GradientText text="Operator" />}
                    </React.Fragment>
                  ))}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};

// Chart Components
const RevenueLineChart = () => (
  <svg className="w-full h-20" viewBox="0 0 240 60">
    <defs>
      <linearGradient id="revenueGradient" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity="0.8"/>
        <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity="0"/>
      </linearGradient>
    </defs>
    <path
      d="M 10 50 Q 40 35 70 25 T 130 15 T 190 20 T 230 12"
      stroke="rgb(16 185 129)"
      strokeWidth="2"
      fill="none"
    />
    <path
      d="M 10 50 Q 40 35 70 25 T 130 15 T 190 20 T 230 12 L 230 55 L 10 55 Z"
      fill="url(#revenueGradient)"
    />
    <circle cx="230" cy="12" r="3" fill="rgb(16 185 129)">
      <animate attributeName="r" values="3;5;3" dur="2s" repeatCount="indefinite"/>
    </circle>
  </svg>
);

const CustomerPieChart = () => (
  <svg className="w-20 h-20" viewBox="0 0 42 42">
    <circle cx="21" cy="21" r="15.915" fill="transparent" stroke="rgb(59 130 246)" strokeWidth="3" strokeDasharray="34 66" strokeDashoffset="25"/>
    <circle cx="21" cy="21" r="15.915" fill="transparent" stroke="rgb(16 185 129)" strokeWidth="3" strokeDasharray="21 79" strokeDashoffset="59"/>
    <circle cx="21" cy="21" r="15.915" fill="transparent" stroke="rgb(168 85 247)" strokeWidth="3" strokeDasharray="15 85" strokeDashoffset="38"/>
    <circle cx="21" cy="21" r="15.915" fill="transparent" stroke="rgb(251 146 60)" strokeWidth="3" strokeDasharray="10 90" strokeDashoffset="23"/>
    <circle cx="21" cy="21" r="15.915" fill="transparent" stroke="rgb(239 68 68)" strokeWidth="3" strokeDasharray="20 80" strokeDashoffset="13"/>
  </svg>
);

const ConversionFunnelChart = () => (
  <svg className="w-full h-20" viewBox="0 0 200 60">
    <polygon points="10,10 190,10 170,25 30,25" fill="rgb(168 85 247)" fillOpacity="0.8"/>
    <polygon points="30,25 170,25 150,40 50,40" fill="rgb(168 85 247)" fillOpacity="0.6"/>
    <polygon points="50,40 150,40 130,55 70,55" fill="rgb(168 85 247)" fillOpacity="0.4"/>
    <text x="100" y="20" textAnchor="middle" className="text-xs fill-white">Visitors: 10,000</text>
    <text x="100" y="35" textAnchor="middle" className="text-xs fill-white">Leads: 2,100</text>
    <text x="100" y="50" textAnchor="middle" className="text-xs fill-white">Sales: 840</text>
  </svg>
);

const SalesBarChart = () => (
  <svg className="w-full h-20" viewBox="0 0 240 60">
    <rect x="20" y="35" width="25" height="20" fill="rgb(251 146 60)" rx="2"/>
    <rect x="55" y="25" width="25" height="30" fill="rgb(251 146 60)" rx="2"/>
    <rect x="90" y="15" width="25" height="40" fill="rgb(251 146 60)" rx="2"/>
    <rect x="125" y="30" width="25" height="25" fill="rgb(251 146 60)" rx="2"/>
    <rect x="160" y="20" width="25" height="35" fill="rgb(251 146 60)" rx="2"/>
    <rect x="195" y="10" width="25" height="45" fill="rgb(251 146 60)" rx="2"/>
    <text x="32" y="50" textAnchor="middle" className="text-xs fill-current">Jan</text>
    <text x="67" y="50" textAnchor="middle" className="text-xs fill-current">Feb</text>
    <text x="102" y="50" textAnchor="middle" className="text-xs fill-current">Mar</text>
    <text x="137" y="50" textAnchor="middle" className="text-xs fill-current">Apr</text>
    <text x="172" y="50" textAnchor="middle" className="text-xs fill-current">May</text>
    <text x="207" y="50" textAnchor="middle" className="text-xs fill-current">Jun</text>
  </svg>
);

const ActivityHeatMap = () => (
  <svg className="w-full h-16" viewBox="0 0 168 32">
    {Array.from({ length: 7 }).map((_, week) =>
      Array.from({ length: 24 }).map((_, hour) => (
        <rect
          key={`${week}-${hour}`}
          x={hour * 7}
          y={week * 4}
          width="6"
          height="3"
          fill={`rgb(236 72 153)`}
          fillOpacity={Math.random() * 0.8 + 0.2}
          rx="1"
        />
      ))
    )}
  </svg>
);

const MarketTrendChart = () => (
  <svg className="w-full h-20" viewBox="0 0 240 60">
    <defs>
      <linearGradient id="marketGradient" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="rgb(99 102 241)" stopOpacity="0.8"/>
        <stop offset="100%" stopColor="rgb(99 102 241)" stopOpacity="0"/>
      </linearGradient>
    </defs>
    <path
      d="M 10 45 Q 30 40 50 35 Q 70 30 90 28 Q 110 25 130 22 Q 150 18 170 15 Q 190 12 210 10 T 230 8"
      stroke="rgb(99 102 241)"
      strokeWidth="2"
      fill="none"
    />
    <path
      d="M 10 45 Q 30 40 50 35 Q 70 30 90 28 Q 110 25 130 22 Q 150 18 170 15 Q 190 12 210 10 T 230 8 L 230 55 L 10 55 Z"
      fill="url(#marketGradient)"
    />
    <circle cx="230" cy="8" r="3" fill="rgb(99 102 241)">
      <animate attributeName="r" values="3;5;3" dur="2s" repeatCount="indefinite"/>
    </circle>
  </svg>
);

const AutomationSkeleton = () => {
  return (
    <div className="relative h-full min-h-[200px] lg:min-h-[300px] bg-gradient-to-br from-muted/20 to-transparent rounded-xl p-6 overflow-hidden">
      <div className="space-y-4">
        <div className="flex justify-between items-center text-xs">
          <div className="flex gap-3">
            <span className="text-muted-foreground">Mon</span>
            <span className="text-muted-foreground">Tue</span>
            <span className="font-semibold text-primary">Wed</span>
            <span className="text-muted-foreground">Thu</span>
            <span className="text-muted-foreground">Fri</span>
          </div>
          <span className="text-muted-foreground">12:00 PM</span>
        </div>
        
        <div className="space-y-3">
          <motion.div 
            className="bg-secondary/10 border border-secondary/20 px-4 py-2 rounded-lg text-sm font-medium"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            Process monthly reports
          </motion.div>
          <motion.div 
            className="bg-muted/50 border border-border/50 px-4 py-2 rounded-lg text-sm font-medium"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
          >
            Send client updates
          </motion.div>
          <motion.div 
            className="border-2 border-dashed border-muted-foreground/20 text-muted-foreground px-4 py-2 rounded-lg text-sm text-center"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
          >
            + Add automation
          </motion.div>
        </div>
        
        <div className="flex gap-1 mt-6">
          <div className="h-1 bg-secondary rounded-full flex-1"></div>
          <div className="h-1 bg-secondary/50 rounded-full flex-1"></div>
          <div className="h-1 bg-muted rounded-full flex-1"></div>
        </div>
      </div>
      
      <div className="absolute top-4 right-4 w-6 h-6 bg-secondary/20 rounded-full flex items-center justify-center">
        <RefreshCw className="w-3 h-3 text-secondary animate-spin" style={{ animationDuration: '3s' }} />
      </div>
    </div>
  );
};
