'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence, useScroll, useInView } from 'framer-motion';

interface DeliverableType {
  type: string;
  description: string;
  preview: React.ReactNode;
}

const deliverables: DeliverableType[] = [
  {
    type: 'Presentations',
    description: 'Create comprehensive, professional presentations with detailed research, compelling visuals, and strategic insights. From pitch decks to quarterly reports, our AI delivers presentation-ready content that impresses stakeholders and drives decisions.',
    preview: (
      <div className="w-full h-full bg-gradient-to-br from-red-50 to-pink-50 dark:from-red-950/20 dark:to-pink-950/20 rounded-2xl p-6 border border-red-200/50 dark:border-red-800/50 shadow-2xl">
        <div className="grid grid-cols-2 gap-6 h-full">
          {/* Left Column */}
          <div className="space-y-4">
            <div>
              <h3 className="font-semibold text-sm mb-2 text-foreground">Phase 5: Pipeline Management</h3>
              <ul className="space-y-1 text-xs text-muted-foreground">
                <li>• Update candidate status in real-time</li>
                <li>• Manage follow-up sequences</li>
                <li>• Track progression through hiring stages</li>
              </ul>
            </div>
            <div>
              <h3 className="font-semibold text-sm mb-2 text-foreground">Phase 6: Analytics & Reporting</h3>
              <ul className="space-y-1 text-xs text-muted-foreground">
                <li>• Generate comprehensive weekly reports</li>
                <li>• Create data visualizations and charts</li>
                <li>• Provide strategic recommendations</li>
              </ul>
            </div>
            <div className="bg-card/50 rounded-lg p-3 border border-border/50">
              <h4 className="font-semibold text-xs mb-1 text-foreground">Automation Schedule</h4>
              <p className="text-xs text-muted-foreground">Every Monday at 9:00 AM, your agent will automatically process new job positions.</p>
            </div>
          </div>
          
          {/* Right Column */}
          <div className="space-y-4">
            <div className="bg-primary/5 rounded-lg p-4 border border-primary/20">
              <h3 className="font-semibold text-sm mb-2 text-primary">Seed VC Associate Recruitment Campaign - COMPLETE</h3>
              <p className="text-xs text-muted-foreground mb-3">I've successfully completed a comprehensive recruitment campaign for the Seed VC Associate position at Founders Future.</p>
              
              <div className="space-y-2">
                <h4 className="font-medium text-xs text-foreground">📊 FINAL DELIVERABLES:</h4>
                <ul className="text-xs text-muted-foreground space-y-1">
                  <li><strong>1. Candidate Pipeline:</strong> 15 high-quality candidates identified and scored</li>
                  <li className="ml-4">• Top Tier (9-10/10): 3 exceptional candidates</li>
                  <li className="ml-4">• Strong Tier (7-8/10): 7 very good candidates</li>
                  <li className="ml-4">• Good Tier (5-6/10): 5 solid candidates</li>
                  <li><strong>2. Comprehensive Google Sheet:</strong> Live Candidate Database</li>
                  <li><strong>3. Strategic Insights & Recommendations</strong></li>
                </ul>
              </div>
            </div>
            
            <div className="bg-secondary/5 rounded-lg p-3 border border-secondary/20">
              <h4 className="font-medium text-xs mb-2 text-secondary">🎯 TOP 3 CANDIDATES TO PRIORITIZE</h4>
              <p className="text-xs text-muted-foreground">Market Analysis, Compensation Insights, Sourcing Strategy recommendations included.</p>
            </div>
          </div>
        </div>
      </div>
    ),
  },
  {
    type: 'Spreadsheets',
    description: 'Transform raw data into actionable insights with advanced spreadsheet analysis, automated calculations, and dynamic reporting. Our AI creates sophisticated data models that track performance, identify trends, and support strategic decision-making.',
    preview: (
      <div className="w-full h-full bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-950/20 dark:to-emerald-950/20 rounded-2xl p-6 border border-green-200/50 dark:border-green-800/50 shadow-2xl">
        <div className="h-full">
          <div className="grid grid-cols-6 gap-1 h-full">
            <div className="space-y-1">
              <div className="h-6 bg-green-200 dark:bg-green-800 rounded text-xs flex items-center justify-center font-semibold">Name</div>
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="h-4 bg-green-100 dark:bg-green-900/50 rounded text-xs flex items-center px-1">
                  Candidate {i + 1}
                </div>
              ))}
            </div>
            <div className="space-y-1">
              <div className="h-6 bg-green-200 dark:bg-green-800 rounded text-xs flex items-center justify-center font-semibold">Score</div>
              {[9.2, 8.8, 8.5, 8.3, 7.9, 7.7, 7.5, 7.2, 6.9, 6.5, 6.2, 6.0].map((score, i) => (
                <div key={i} className="h-4 bg-green-100 dark:bg-green-900/50 rounded text-xs flex items-center justify-center">
                  {score}
                </div>
              ))}
            </div>
            <div className="space-y-1">
              <div className="h-6 bg-green-200 dark:bg-green-800 rounded text-xs flex items-center justify-center font-semibold">Experience</div>
              {['5-7y', '4-6y', '6-8y', '3-5y', '4-7y', '5-6y', '3-4y', '2-4y', '4-5y', '3-6y', '2-3y', '1-3y'].map((exp, i) => (
                <div key={i} className="h-4 bg-green-100 dark:bg-green-900/50 rounded text-xs flex items-center justify-center">
                  {exp}
                </div>
              ))}
            </div>
            <div className="space-y-1">
              <div className="h-6 bg-green-200 dark:bg-green-800 rounded text-xs flex items-center justify-center font-semibold">Location</div>
              {['SF', 'NYC', 'LA', 'SF', 'NYC', 'Austin', 'SF', 'Seattle', 'NYC', 'Boston', 'SF', 'LA'].map((loc, i) => (
                <div key={i} className="h-4 bg-green-100 dark:bg-green-900/50 rounded text-xs flex items-center justify-center">
                  {loc}
                </div>
              ))}
            </div>
            <div className="space-y-1">
              <div className="h-6 bg-green-200 dark:bg-green-800 rounded text-xs flex items-center justify-center font-semibold">Status</div>
              {['Contacted', 'Interview', 'Pending', 'Contacted', 'New', 'Interview', 'Contacted', 'New', 'Pending', 'New', 'Contacted', 'New'].map((status, i) => (
                <div key={i} className={`h-4 rounded text-xs flex items-center justify-center ${
                  status === 'Interview' ? 'bg-yellow-200 dark:bg-yellow-800' :
                  status === 'Contacted' ? 'bg-blue-200 dark:bg-blue-800' :
                  status === 'Pending' ? 'bg-orange-200 dark:bg-orange-800' :
                  'bg-gray-200 dark:bg-gray-800'
                }`}>
                  {status}
                </div>
              ))}
            </div>
            <div className="space-y-1">
              <div className="h-6 bg-green-200 dark:bg-green-800 rounded text-xs flex items-center justify-center font-semibold">Notes</div>
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="h-4 bg-green-100 dark:bg-green-900/50 rounded text-xs flex items-center px-1">
                  Notes...
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    ),
  },
  {
    type: 'Design',
    description: 'Generate stunning visual designs, wireframes, and mockups that capture your brand vision. From user interface designs to marketing materials, our AI creates cohesive visual assets that engage audiences and communicate effectively.',
    preview: (
      <div className="w-full h-full bg-gradient-to-br from-purple-50 to-violet-50 dark:from-purple-950/20 dark:to-violet-950/20 rounded-2xl p-6 border border-purple-200/50 dark:border-purple-800/50 shadow-2xl flex items-center justify-center">
        <div className="relative w-full max-w-sm h-80 bg-card rounded-xl shadow-lg border border-border p-4">
          <div className="absolute top-4 left-4 w-16 h-4 bg-purple-200 dark:bg-purple-800 rounded"></div>
          <div className="absolute top-10 left-4 w-24 h-2 bg-purple-100 dark:bg-purple-900 rounded"></div>
          
          <div className="absolute top-20 left-4 right-4 h-32 bg-gradient-to-br from-purple-100 to-violet-100 dark:from-purple-900/50 dark:to-violet-900/50 rounded-lg border border-purple-200 dark:border-purple-800 flex items-center justify-center">
            <div className="text-center">
              <div className="w-12 h-12 bg-purple-300 dark:bg-purple-700 rounded-full mx-auto mb-2"></div>
              <div className="w-20 h-2 bg-purple-200 dark:bg-purple-800 rounded mx-auto"></div>
            </div>
          </div>
          
          <div className="absolute bottom-16 left-4 right-4 space-y-2">
            <div className="h-2 bg-purple-100 dark:bg-purple-900 rounded w-full"></div>
            <div className="h-2 bg-purple-100 dark:bg-purple-900 rounded w-3/4"></div>
            <div className="h-2 bg-purple-100 dark:bg-purple-900 rounded w-5/6"></div>
          </div>
          
          <div className="absolute bottom-4 right-4 w-16 h-8 bg-purple-500 dark:bg-purple-600 rounded text-white text-xs flex items-center justify-center">
            CTA
          </div>
        </div>
      </div>
    ),
  },
  {
    type: 'Documentation',
    description: 'Produce detailed, well-structured documentation that makes complex information accessible. From technical manuals to user guides, our AI creates clear, comprehensive documentation that improves understanding and reduces support overhead.',
    preview: (
      <div className="w-full h-full bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/20 dark:to-indigo-950/20 rounded-2xl p-6 border border-blue-200/50 dark:border-blue-800/50 shadow-2xl">
        <div className="space-y-4 h-full">
          <div className="h-6 bg-blue-200 dark:bg-blue-800 rounded w-2/3"></div>
          
          <div className="space-y-2">
            <div className="h-3 bg-blue-100 dark:bg-blue-900 rounded w-full"></div>
            <div className="h-3 bg-blue-100 dark:bg-blue-900 rounded w-11/12"></div>
            <div className="h-3 bg-blue-100 dark:bg-blue-900 rounded w-10/12"></div>
          </div>
          
          <div className="pt-2">
            <div className="h-4 bg-blue-200 dark:bg-blue-800 rounded w-1/2 mb-2"></div>
            <div className="space-y-2">
              <div className="h-3 bg-blue-100 dark:bg-blue-900 rounded w-full"></div>
              <div className="h-3 bg-blue-100 dark:bg-blue-900 rounded w-9/12"></div>
              <div className="h-3 bg-blue-100 dark:bg-blue-900 rounded w-10/12"></div>
              <div className="h-3 bg-blue-100 dark:bg-blue-900 rounded w-8/12"></div>
            </div>
          </div>
          
          <div className="pt-2">
            <div className="h-4 bg-blue-200 dark:bg-blue-800 rounded w-2/5 mb-2"></div>
            <div className="space-y-2">
              <div className="h-3 bg-blue-100 dark:bg-blue-900 rounded w-full"></div>
              <div className="h-3 bg-blue-100 dark:bg-blue-900 rounded w-11/12"></div>
              <div className="h-3 bg-blue-100 dark:bg-blue-900 rounded w-7/12"></div>
            </div>
          </div>
          
          <div className="bg-blue-100 dark:bg-blue-900/50 rounded-lg p-3 border border-blue-200 dark:border-blue-800">
            <div className="h-3 bg-blue-200 dark:bg-blue-800 rounded w-1/3 mb-2"></div>
            <div className="space-y-1">
              <div className="h-2 bg-blue-150 dark:bg-blue-850 rounded w-full"></div>
              <div className="h-2 bg-blue-150 dark:bg-blue-850 rounded w-4/5"></div>
            </div>
          </div>
        </div>
      </div>
    ),
  },
  {
    type: 'Data Visualizations',
    description: 'Build interactive dashboards and compelling data visualizations that tell your data story. Our AI transforms complex datasets into clear, actionable charts and graphs that reveal patterns, highlight opportunities, and support data-driven decisions.',
    preview: (
      <div className="w-full h-full bg-gradient-to-br from-orange-50 to-amber-50 dark:from-orange-950/20 dark:to-amber-950/20 rounded-2xl p-6 border border-orange-200/50 dark:border-orange-800/50 shadow-2xl">
        <div className="h-full flex flex-col">
          <div className="mb-4">
            <div className="h-4 bg-orange-200 dark:bg-orange-800 rounded w-1/2 mb-2"></div>
            <div className="h-2 bg-orange-100 dark:bg-orange-900 rounded w-3/4"></div>
          </div>
          
          <div className="flex-1 flex items-end justify-center space-x-2">
            {[
              { height: '60%', label: 'Q1' },
              { height: '80%', label: 'Q2' },
              { height: '100%', label: 'Q3' },
              { height: '75%', label: 'Q4' },
              { height: '90%', label: 'Q5' }
            ].map((bar, i) => (
              <div key={i} className="flex flex-col items-center">
                <div 
                  className="w-8 bg-gradient-to-t from-orange-400 to-orange-300 dark:from-orange-600 dark:to-orange-500 rounded-t"
                  style={{ height: bar.height }}
                ></div>
                <div className="text-xs mt-1 text-orange-600 dark:text-orange-400">{bar.label}</div>
              </div>
            ))}
          </div>
          
          <div className="mt-4 grid grid-cols-3 gap-2">
            <div className="bg-orange-100 dark:bg-orange-900/50 rounded p-2 text-center">
              <div className="text-lg font-bold text-orange-600 dark:text-orange-400">85%</div>
              <div className="text-xs text-orange-500 dark:text-orange-500">Growth</div>
            </div>
            <div className="bg-orange-100 dark:bg-orange-900/50 rounded p-2 text-center">
              <div className="text-lg font-bold text-orange-600 dark:text-orange-400">$2.4M</div>
              <div className="text-xs text-orange-500 dark:text-orange-500">Revenue</div>
            </div>
            <div className="bg-orange-100 dark:bg-orange-900/50 rounded p-2 text-center">
              <div className="text-lg font-bold text-orange-600 dark:text-orange-400">156</div>
              <div className="text-xs text-orange-500 dark:text-orange-500">Clients</div>
            </div>
          </div>
        </div>
      </div>
    ),
  },
];

export function DeliverablesSection() {
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(containerRef, { margin: "-50%" });
  
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start end', 'end start']
  });

  // Calculate which deliverable should be active based on scroll progress
  useEffect(() => {
    const unsubscribe = scrollYProgress.on('change', (latest) => {
      if (latest > 0.1 && latest < 0.9) {
        const adjustedProgress = (latest - 0.1) / 0.8; // Normalize to 0-1 range
        const index = Math.min(
          Math.floor(adjustedProgress * deliverables.length),
          deliverables.length - 1
        );
        setActiveIndex(index);
      }
    });

    return unsubscribe;
  }, [scrollYProgress]);

  return (
    <section 
      ref={containerRef} 
      id="deliverables"
      className="flex flex-col items-center justify-center w-full relative"
    >
      <div className="relative w-full px-6">
        <div className="max-w-6xl mx-auto border-l border-r border-border">
          {/* Section Header */}
          <div className="flex flex-col items-center justify-center gap-6 py-20 px-6">
            <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance">
              24/7 AI Workers for Every Task
            </h2>
            <p className="text-muted-foreground text-center text-balance font-medium max-w-3xl text-lg">
              From presentations to data analysis, our AI workers handle complex deliverables while you focus on what matters most. Each worker is specialized, intelligent, and works around the clock to deliver professional results.
            </p>
          </div>

          {/* Sticky Content Area - Locks during scroll */}
          <div className="sticky top-0 h-screen flex items-center justify-center w-full bg-background border-t border-border">
            <div className="relative w-full">
              <div className="max-w-6xl mx-auto px-6">
                {/* Content Grid */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center">
                  {/* Left Side - Text */}
                  <motion.div
                    initial={{ opacity: 0, x: -50 }}
                    animate={{ opacity: isInView ? 1 : 0, x: isInView ? 0 : -50 }}
                    transition={{ duration: 0.8 }}
                    className="flex flex-col items-start justify-center gap-2"
                  >
                    <motion.h3
                      className="text-3xl md:text-4xl lg:text-5xl font-medium tracking-tighter text-balance mb-6"
                      key={`title-${activeIndex}`}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.6 }}
                    >
                      <span className="text-foreground">AI Worker for </span>
                      <span className="text-primary">{deliverables[activeIndex].type}</span>
                    </motion.h3>
                    
                    <motion.p
                      className="text-muted-foreground text-balance font-medium mb-8 text-lg leading-relaxed"
                      key={`desc-${activeIndex}`}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.6, delay: 0.1 }}
                    >
                      {deliverables[activeIndex].description}
                    </motion.p>

                    <motion.button
                      className="group inline-flex h-12 items-center justify-center gap-2 text-base font-medium tracking-wide rounded-full text-primary-foreground dark:text-black px-8 shadow-[inset_0_1px_2px_rgba(255,255,255,0.25),0_3px_3px_-1.5px_rgba(16,24,40,0.06),0_1px_1px_rgba(16,24,40,0.08)] bg-primary dark:bg-white hover:bg-primary/90 dark:hover:bg-white/90 transition-all duration-200 w-fit mb-8"
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.6, delay: 0.2 }}
                    >
                      <span>Get Started</span>
                      <span className="inline-flex items-center justify-center size-6 rounded-full bg-white/20 dark:bg-black/10 group-hover:bg-white/30 dark:group-hover:bg-black/20 transition-colors duration-200">
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                          className="text-primary-foreground dark:text-black"
                        >
                          <path
                            d="M7 17L17 7M17 7H8M17 7V16"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        </span>
                    </motion.button>

                    {/* Progress Indicator */}
                    <div className="flex space-x-3">
                      {deliverables.map((_, index) => (
                        <button
                          key={index}
                          onClick={() => setActiveIndex(index)}
                          className={`h-3 rounded-full transition-all duration-500 cursor-pointer hover:bg-primary/70 ${
                            index === activeIndex
                              ? 'w-10 bg-primary shadow-lg shadow-primary/25'
                              : 'w-3 bg-muted-foreground/30'
                          }`}
                        />
                      ))}
                    </div>
                  </motion.div>

                  {/* Right Side - Preview */}
                  <motion.div
                    initial={{ opacity: 0, x: 50 }}
                    animate={{ opacity: isInView ? 1 : 0, x: isInView ? 0 : 50 }}
                    transition={{ duration: 0.8, delay: 0.2 }}
                    className="flex flex-col items-center justify-center h-[600px]"
                  >
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={activeIndex}
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        transition={{ 
                          duration: 0.5,
                          ease: [0.4, 0, 0.2, 1]
                        }}
                        className="w-full h-full"
                      >
                        {deliverables[activeIndex].preview}
                      </motion.div>
                    </AnimatePresence>
                  </motion.div>
                </div>
              </div>
            </div>
          </div>

          {/* Spacer sections for scroll trigger - each deliverable gets its own scroll space */}
          <div className="relative">
            {deliverables.map((deliverable, index) => (
              <div
                key={index}
                className="h-screen opacity-0 pointer-events-none"
                data-deliverable={deliverable.type}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
