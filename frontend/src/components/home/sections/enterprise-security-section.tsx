'use client';

import { SectionHeader } from '@/components/home/section-header';
import { ProfileCard } from '@/components/ProfileCard';
import { AgentProfileCard } from '@/components/ProfileCard/AgentProfileCard';
import { InfoCard } from '@/components/InfoCard';
import { IconCloud } from '@/components/magicui/icon-cloud';
import { AnimatedBeam } from '@/components/magicui/animated-beam';
import { GradientText } from '@/components/animate-ui/text/gradient';
import { OmniProcessModal } from '@/components/sidebar/omni-enterprise-modal';

import { Shield, Lock, Brain, Database, Zap, Users2, Settings } from 'lucide-react';
import { useRef, forwardRef } from 'react';
import { cn } from '@/lib/utils';

// Clean white pill component for features
const FeaturePill = forwardRef<
  HTMLDivElement,
  { 
    icon: React.ReactNode; 
    title: string; 
    description: string; 
    className?: string;
    floatDelay?: number;
    enableFloat?: boolean;
  }
>(({ icon, title, description, className, floatDelay = 0, enableFloat = false }, ref) => {
  return (
    <div
      ref={ref}
      className={cn(
        "bg-white dark:bg-gray-900 rounded-full px-6 py-5 shadow-lg border border-gray-200 dark:border-gray-700",
        "flex items-center gap-4 min-w-[360px] max-w-[380px]",
        "hover:shadow-xl transition-all duration-300 hover:scale-105",
        "backdrop-blur-sm bg-white/80 dark:bg-gray-900/80",
        enableFloat && "animate-float",
        className
      )}
      style={enableFloat ? {
        animationDelay: `${floatDelay}s`,
        animationDuration: `${6 + Math.random() * 2}s`
      } : {}}
    >
      <div className="flex-shrink-0 w-10 h-10 bg-secondary/10 rounded-full flex items-center justify-center border border-secondary/20">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">
          {title}
        </h4>
        <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed">
          {description}
        </p>
      </div>
    </div>
  );
});

FeaturePill.displayName = "FeaturePill";

export function EnterpriseSecuritySection() {
  // Refs for AnimatedBeam connections
  const containerRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const feature1Ref = useRef<HTMLDivElement>(null);
  const feature2Ref = useRef<HTMLDivElement>(null);
  const feature3Ref = useRef<HTMLDivElement>(null);
  const feature4Ref = useRef<HTMLDivElement>(null);
  const feature5Ref = useRef<HTMLDivElement>(null);

  // Transform secure AI features to match InfoCard interface
  const secureAIAgents = [
    {
      agent_id: 'private-ai-training',
      name: 'Private AI Training',
      description: 'Train AI models exclusively on your proprietary data. Create specialized capabilities tailored to your industry while ensuring your competitive insights never leave your organization.',
      avatar: '🔒',
      avatar_color: '#3B82F6',
      tags: ['Zero Data Leakage', 'Proprietary Training', 'Competitive Edge'],
      keyPoints: [
        'Models trained exclusively on your data',
        'Intellectual property remains secure',
        'Domain-specific AI capabilities',
        'Your data becomes your competitive moat'
      ]
    },
    {
      agent_id: 'zero-trust-security',
      name: 'Zero-Trust Security',
      description: 'Military-grade security with zero-trust architecture. Every interaction is encrypted with AES-256 standards and continuous threat monitoring.',
      avatar: '🛡️',
      avatar_color: '#10B981',
      tags: ['AES-256 Encryption', 'Zero-Trust Architecture', 'Real-time Monitoring'],
      keyPoints: [
        'End-to-end encryption for all data transfers',
        'Network segmentation & identity verification',
        'Real-time threat detection & response',
        'Behavioral analysis & automated security'
      ]
    },
    {
      agent_id: 'competitive-moat',
      name: 'Competitive Moat',
      description: 'Protect your market position with isolated AI ecosystems. Your insights, customer intelligence, and strategic data stay exclusively yours.',
      avatar: '⚔️',
      avatar_color: '#8B5CF6',
      tags: ['Data Isolation', 'Competitor Protection', 'IP Safeguarding'],
      keyPoints: [
        'Proprietary insights never benefit competitors',
        'Advanced data lineage tracking',
        'Ironclad data sovereignty guarantees',
        'Strategic intelligence remains internal'
      ]
    },
    {
      agent_id: 'enterprise-sovereignty',
      name: 'Enterprise Sovereignty',
      description: 'Complete control over your AI infrastructure with full data sovereignty and private cloud deployment. No external dependencies.',
      avatar: '👑',
      avatar_color: '#F59E0B',
      tags: ['Private Cloud', 'Full Data Ownership', 'Custom Governance'],
      keyPoints: [
        'Dedicated private cloud infrastructure',
        'Complete administrative control',
        'Custom governance frameworks',
        'Zero external dependencies'
      ]
    }
  ];

  // Enterprise integration icon slugs for IconCloud - using verified Simple Icons slugs
  const enterpriseIntegrationSlugs = [
    // ERP & Business Systems
    "sap", "oracle", "microsoft", "salesforce", "servicenow", "atlassian", "tableau",
    
    // Manufacturing & Industrial
    "siemens", "abb", "generalelectric",
    
    // Supply Chain & Logistics
    "fedex", "ups", "dhl", "caterpillar", "johndeere",
    
    // Financial & Accounting
    "stripe", "paypal", "visa", "mastercard", "americanexpress",
    
    // Cloud & Infrastructure
    "amazonaws", "microsoftazure", "googlecloud", "oracle", "ibm", "vmware", "redhat", "docker", "kubernetes",
    
    // Communication & Collaboration
    "microsoft", "slack", "zoom", "discord", "telegram", "whatsapp",
    
    // Document & Content Management
    "adobe", "dropbox", "box", "googledrive", "notion", "confluence",
    
    // Security & Compliance
    "okta", "auth0", "paloaltonetworks", "fortinet", "zscaler",
    
    // Quality & Testing
    "jenkins", "gitlab", "github", "sonarqube", "cypress", "selenium",
    
    // IoT & Sensors
    "nvidia", "intel", "qualcomm", "arm", "broadcom",
    
    // Time & Scheduling
    "calendly", "microsoftoutlook", "googlecalendar", "hubspot", "zendesk",
    
    // Workflow & Automation
    "zapier"
  ];

  // Convert slugs to image URLs - all slugs are now verified to exist on Simple Icons
  const enterpriseIntegrationImages = enterpriseIntegrationSlugs.map(
    (slug) => `https://cdn.simpleicons.org/${slug}`
  );

  return (
    <section
      id="enterprise-security"
      className="flex flex-col items-center justify-center w-full relative pt-24 lg:pt-32 pb-12 lg:pb-16"
    >
      <div className="w-full max-w-7xl mx-auto px-6">
        {/* Header Section */}
        <div className="text-center mb-20">
          <div className="flex items-center justify-center gap-3 mb-8">
            <div className="p-3 bg-secondary/10 rounded-2xl border border-secondary/20">
              <Shield className="h-6 w-6 text-secondary" />
            </div>
            <span className="text-sm font-semibold text-secondary uppercase tracking-wider">
              Trusted by Enterprise • <GradientText text="AI" /> Security
            </span>
          </div>
          
          <h2 className="text-4xl md:text-5xl lg:text-6xl font-semibold tracking-tight text-balance leading-[1.05] mb-8">
            Built for Secure Growth
          </h2>
          
          <div className="max-w-4xl mx-auto space-y-6">
            <p className="text-xl md:text-2xl text-muted-foreground font-normal leading-relaxed">
              Trusted by enterprise leaders who value data sovereignty and competitive advantage.
            </p>
            <p className="text-lg md:text-xl text-muted-foreground/70 font-normal leading-relaxed max-w-3xl mx-auto">
              Supercharge your business with <GradientText text="AI" /> that learns exclusively from your proprietary assets—without sharing your advantage with competitors or public models.
            </p>
          </div>
        </div>

        {/* Feature Cards - 2x2 Grid using InfoCard */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12 max-w-6xl mx-auto">
          {secureAIAgents.map((agent) => (
            <InfoCard
              key={agent.agent_id}
              title={agent.name}
              description={agent.description}
              avatar={agent.avatar}
              avatar_color={agent.avatar_color}
              tags={agent.tags}
              keyPoints={agent.keyPoints}
              className="min-h-[380px] lg:h-[420px] h-auto"
              enableTilt={true}
            />
          ))}
        </div>

        {/* Enterprise Connections Section with AnimatedBeam */}
        <div className="mt-24 lg:mt-32">
          <div className="text-center mb-16">
            <h3 className="text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tight text-balance leading-[1.05] mb-6">
              Connect Your <GradientText text="Operator" /> Securely to Enterprise Data and Tools
            </h3>
            <p className="text-lg md:text-xl text-muted-foreground font-normal leading-relaxed max-w-3xl mx-auto">
              Seamlessly integrate with your existing enterprise infrastructure while maintaining zero-trust security protocols.
            </p>
          </div>

          {/* Mobile Layout - Stacked vertically */}
          <div className="block lg:hidden">
            <div className="space-y-6">
              {/* Central Icon Cloud for mobile */}
              <div className="flex items-center justify-center mb-8 px-4">
                <div className="relative w-[280px] h-[280px] sm:w-[320px] sm:h-[320px] bg-gradient-to-br from-secondary/5 to-primary/5 rounded-full border border-border/30 shadow-lg backdrop-blur-sm">
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-full h-full flex items-center justify-center">
                      <div className="block sm:hidden">
                        <IconCloud 
                          images={enterpriseIntegrationImages} 
                          width={280} 
                          height={280}
                        />
                      </div>
                      <div className="hidden sm:block">
                        <IconCloud 
                          images={enterpriseIntegrationImages} 
                          width={320} 
                          height={320}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Feature Pills */}
              <div className="flex justify-center px-4">
                <FeaturePill
                  icon={<Shield className="h-5 w-5 text-secondary" />}
                  title="Zero-Trust Authentication"
                  description="Secure API connections with enterprise-grade authentication and authorization protocols."
                />
              </div>
              <div className="flex justify-center px-4">
                <FeaturePill
                  icon={<Lock className="h-5 w-5 text-secondary" />}
                  title="End-to-End Encryption"
                  description="All data transfers are encrypted with AES-256 standards, ensuring complete privacy."
                />
              </div>
              <div className="flex justify-center px-4">
                <FeaturePill
                  icon={<Zap className="h-5 w-5 text-secondary" />}
                  title="Real-Time Sync"
                  description="Instant synchronization with your enterprise systems for up-to-date insights."
                />
              </div>
              <div className="flex justify-center px-4">
                <FeaturePill
                  icon={<Users2 className="h-5 w-5 text-secondary" />}
                  title="RBAC"
                  description="Role-based access control with granular permissions and enterprise-grade user management."
                />
              </div>
              <div className="flex justify-center px-4">
                <FeaturePill
                  icon={<Settings className="h-5 w-5 text-secondary" />}
                  title="Custom Integration Development"
                  description="Tailored integration solutions for your unique enterprise systems and workflows."
                />
              </div>
            </div>
          </div>

          {/* Desktop Layout with AnimatedBeam */}
          <div className="hidden lg:block">
            <div 
              ref={containerRef}
              className="relative w-full max-w-6xl mx-auto h-[700px] overflow-hidden"
            >
              {/* Central Icon Cloud in Container */}
              <div 
                ref={centerRef}
                className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-[280px] h-[280px] z-10 bg-gradient-to-br from-secondary/5 to-primary/5 rounded-full border border-border/30 shadow-lg backdrop-blur-sm overflow-hidden"
              >
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-[280px] h-[280px] flex items-center justify-center">
                    <IconCloud images={enterpriseIntegrationImages} width={280} height={280} />
                  </div>
                </div>
              </div>

              {/* Feature Pills positioned around the center */}
              <div className="absolute top-8 left-1/2 transform -translate-x-1/2">
                <FeaturePill
                  ref={feature1Ref}
                  icon={<Shield className="h-5 w-5 text-secondary" />}
                  title="Zero-Trust Authentication"
                  description="Secure API connections with enterprise-grade authentication and authorization protocols."
                  floatDelay={0}
                  enableFloat={true}
                />
              </div>

              <div className="absolute top-1/2 left-4 transform -translate-y-1/2">
                <FeaturePill
                  ref={feature2Ref}
                  icon={<Lock className="h-5 w-5 text-secondary" />}
                  title="End-to-End Encryption"
                  description="All data transfers are encrypted with AES-256 standards, ensuring complete privacy."
                  floatDelay={1.2}
                  enableFloat={true}
                />
              </div>

              <div className="absolute top-1/2 right-4 transform -translate-y-1/2">
                <FeaturePill
                  ref={feature3Ref}
                  icon={<Zap className="h-5 w-5 text-secondary" />}
                  title="Real-Time Sync"
                  description="Instant synchronization with your enterprise systems for up-to-date insights."
                  floatDelay={2.4}
                  enableFloat={true}
                />
              </div>

              <div className="absolute bottom-16 left-1/4 transform -translate-x-1/2">
                <FeaturePill
                  ref={feature4Ref}
                  icon={<Users2 className="h-5 w-5 text-secondary" />}
                  title="RBAC"
                  description="Role-based access control with granular permissions and enterprise-grade user management."
                  floatDelay={3.6}
                  enableFloat={true}
                />
              </div>

              <div className="absolute bottom-16 right-1/4 transform translate-x-1/2">
                <FeaturePill
                  ref={feature5Ref}
                  icon={<Settings className="h-5 w-5 text-secondary" />}
                  title="Custom Integration Development"
                  description="Tailored integration solutions for your unique enterprise systems and workflows."
                  floatDelay={4.8}
                  enableFloat={true}
                />
              </div>

              {/* AnimatedBeam connections - exact edge to edge */}
              {/* Top pill to center circle */}
              <AnimatedBeam
                containerRef={containerRef}
                fromRef={feature1Ref}
                toRef={centerRef}
                curvature={-50}
                duration={3}
                delay={0.5}
                startYOffset={37}
                endYOffset={-140}
              />
              {/* Left pill to center circle */}
              <AnimatedBeam
                containerRef={containerRef}
                fromRef={feature2Ref}
                toRef={centerRef}
                curvature={0}
                duration={2.5}
                delay={1}
                startXOffset={169}
                endXOffset={-140}
              />
              {/* Right pill to center circle */}
              <AnimatedBeam
                containerRef={containerRef}
                fromRef={feature3Ref}
                toRef={centerRef}
                curvature={0}
                duration={2.5}
                delay={1.5}
                reverse
                startXOffset={-169}
                endXOffset={140}
              />
              {/* Bottom-left pill to center circle */}
              <AnimatedBeam
                containerRef={containerRef}
                fromRef={feature4Ref}
                toRef={centerRef}
                curvature={80}
                duration={3}
                delay={0.3}
                startXOffset={130}
                startYOffset={-37}
                endXOffset={-85}
                endYOffset={95}
              />
              {/* Bottom-right pill to center circle */}
              <AnimatedBeam
                containerRef={containerRef}
                fromRef={feature5Ref}
                toRef={centerRef}
                curvature={-80}
                duration={3}
                delay={0.8}
                reverse
                startXOffset={-130}
                startYOffset={-37}
                endXOffset={85}
                endYOffset={95}
              />
            </div>
          </div>
        </div>



        {/* CTA Section */}
        <div className="mt-8 lg:mt-10">
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-secondary/5 to-primary/5 border border-border/50 p-12 lg:p-16">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.15)_1px,transparent_0)] [background-size:20px_20px] opacity-20"></div>
            
            <div className="relative z-10 text-center">
              <div className="flex items-center justify-center gap-4 mb-8">
                <Brain className="h-8 w-8 text-secondary" />
                <Database className="h-8 w-8 text-secondary" />
                <Lock className="h-8 w-8 text-secondary" />
              </div>
              
              <h3 className="text-3xl lg:text-4xl font-semibold text-foreground mb-6">
                Ready to Secure Your <GradientText text="AI" /> Advantage?
              </h3>
              
              <p className="text-lg lg:text-xl text-muted-foreground mb-10 leading-relaxed max-w-2xl mx-auto">
                Join industry leaders who trust Omni to deploy <GradientText text="AI" /> that amplifies their competitive edge while protecting their most valuable assets.
              </p>
              
              {/* Enhanced Schedule Demo CTA */}
              <div className="relative group inline-block">
                <div className="absolute -inset-1 bg-gradient-to-r from-secondary to-primary rounded-2xl blur opacity-25 group-hover:opacity-75 transition duration-300"></div>
                <div className="relative group inline-flex h-14 items-center justify-center gap-3 text-base font-semibold tracking-wide rounded-xl text-primary-foreground dark:text-black px-8 shadow-[0_4px_14px_0_rgba(0,0,0,0.1)] bg-primary dark:bg-white hover:bg-primary/90 dark:hover:bg-white/90 transition-all duration-300 hover:shadow-[0_6px_20px_rgba(0,0,0,0.15)] hover:scale-105">
                  <OmniProcessModal />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
} 