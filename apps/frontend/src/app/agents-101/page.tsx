'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Circle, ArrowRight, ArrowDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import Image from 'next/image';

// Slide data structure
interface Slide {
  id: number;
  type: 'title' | 'content' | 'diagram' | 'comparison' | 'speaker' | 'code' | 'event' | 'interactive';
  title?: string;
  subtitle?: string;
  content?: string[];
  bulletPoints?: string[];
  accent?: string;
  diagram?: 'agent-loop' | 'kortix-stack' | 'task-types' | 'token-flow' | 'messages-array' | 'sandbox-arch' | 'tools-overview';
  leftColumn?: { title: string; points: string[] };
  rightColumn?: { title: string; points: string[] };
  codeSnippet?: string;
  codeTitle?: string;
}

const slides: Slide[] = [
  // Part 1: Introduction
  {
    id: 1,
    type: 'event',
    title: 'Workers',
    subtitle: 'Workers Workers Workers',
  },
  {
    id: 2,
    type: 'speaker',
    title: 'Marko Kraemer & Domenico Gagliardi',
    subtitle: 'CEO & COO at Kortix',
  },
  {
    id: 3,
    type: 'title',
    title: 'Demo',
    subtitle: 'Let\'s see Kortix in action',
  },

  // Part 2: What Are Workers?
  {
    id: 4,
    type: 'diagram',
    title: 'What is an AI Worker?',
    subtitle: 'A software system that can perceive its environment, make decisions, and take actions autonomously to achieve specific goals',
    diagram: 'agent-loop',
    accent: '#82DD95',
  },

  // Part 3: Distinguishing Agent Types
  {
    id: 5,
    type: 'comparison',
    title: 'Autonomy vs Determinism',
    leftColumn: {
      title: 'Autonomous AI Worker',
      points: [
        'Runs open-ended until goal is achieved',
        'LLM decides actions at each step',
        'High autonomy, lower predictability',
        'Can use agentic workflows as tools',
      ],
    },
    rightColumn: {
      title: 'Worker Workflow',
      points: [
        'Runs close-ended through fixed steps',
        'LLM used one step at a time, highly controlled',
        'High predictability, lower autonomy',
        'Often mislabeled as "AI Workers"',
      ],
    },
  },

  // Part 4: Interactive Deep Dive
  {
    id: 6,
    type: 'interactive',
    title: 'Building a Worker',
    subtitle: 'Step by step walkthrough',
  },

  // Part 5: Wrap Up
  {
    id: 7,
    type: 'title',
    title: 'Thank You',
    subtitle: 'Questions?',
  },
];

// Grain overlay component
const GrainOverlay = () => (
  <div
    className="absolute inset-0 pointer-events-none opacity-[0.03] z-10"
    style={{
      backgroundImage: 'url(/grain-texture.png)',
      backgroundSize: '100px 100px',
      backgroundRepeat: 'repeat',
      mixBlendMode: 'multiply',
    }}
  />
);

// Worker Loop Diagram - Classic RL cycle
const AgentLoopDiagram = () => (
  <div className="relative w-full max-w-4xl mx-auto">
    <div className="flex items-center justify-center gap-6 md:gap-12">
      {/* Worker */}
      <motion.div
        className="flex flex-col items-center"
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.1 }}
      >
        <div className="w-32 h-32 md:w-40 md:h-40 rounded-2xl bg-[#9DC2FF] flex flex-col items-center justify-center">
          <span className="text-3xl mb-1">🤖</span>
          <span className="text-black font-semibold text-lg md:text-xl">Worker</span>
        </div>
      </motion.div>

      {/* Arrows and Environment */}
      <div className="flex flex-col items-center gap-4">
        {/* Action arrow (going right/down) */}
        <motion.div
          className="flex items-center gap-2"
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.3 }}
        >
          <span className="text-sm font-medium text-[#FFCD7E]">Action</span>
          <ArrowRight className="w-8 h-8 text-[#FFCD7E]" />
        </motion.div>

        {/* Environment */}
        <motion.div
          className="flex flex-col items-center"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2 }}
        >
          <div className="w-32 h-32 md:w-40 md:h-40 rounded-2xl bg-[#82DD95] flex flex-col items-center justify-center">
            <span className="text-3xl mb-1">🌍</span>
            <span className="text-black font-semibold text-lg md:text-xl text-center">Environment</span>
          </div>
        </motion.div>

        {/* State/Reward arrow (going left/up) */}
        <motion.div
          className="flex items-center gap-2"
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.4 }}
        >
          <svg width="32" height="32" viewBox="0 0 24 24" className="text-[#FFB5E4] rotate-180">
            <path d="M5 12h14M12 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span className="text-sm font-medium text-[#FFB5E4]">State + Result</span>
        </motion.div>
      </div>
    </div>

    {/* Caption */}
    <motion.p
      className="text-center text-muted-foreground text-sm mt-8"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.6 }}
    >
      Worker takes action → Environment returns result → Worker decides next action
    </motion.p>
  </div>
);

// Token Flow Diagram
const TokenFlowDiagram = () => {
  const steps = [
    { label: 'LLM Output', content: '{"tool": "write_file",\n "path": "app.js",\n "content": "..."}', color: '#9DC2FF' },
    { label: 'Parse JSON/XML', content: 'Detect structured format\nExtract tool name & args', color: '#FFCD7E' },
    { label: 'Execute Code', content: 'fs.writeFile(\n  "app.js",\n  content\n)', color: '#82DD95' },
    { label: 'Return Result', content: '✓ File written\n→ Add to messages[]', color: '#FFB5E4' },
  ];

  return (
    <div className="w-full max-w-4xl mx-auto">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {steps.map((step, i) => (
          <motion.div
            key={i}
            className="relative"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.15 }}
          >
            <div
              className="rounded-xl p-4 h-full"
              style={{ backgroundColor: step.color }}
            >
              <div className="text-black font-semibold mb-2 text-sm">{step.label}</div>
              <pre className="text-black/70 text-xs font-mono whitespace-pre-wrap">{step.content}</pre>
            </div>
            {i < steps.length - 1 && (
              <div className="hidden md:block absolute top-1/2 -right-3 transform -translate-y-1/2 z-10">
                <ArrowRight className="w-6 h-6 text-foreground/30" />
              </div>
            )}
            {i < steps.length - 1 && (
              <div className="md:hidden flex justify-center py-2">
                <ArrowDown className="w-5 h-5 text-foreground/30" />
              </div>
            )}
          </motion.div>
        ))}
      </div>
    </div>
  );
};

// Messages Array Diagram
const MessagesArrayDiagram = () => {
  const messages = [
    { role: 'system', content: 'You are a coding assistant...', color: '#9DC2FF' },
    { role: 'user', content: 'Create a React component', color: '#82DD95' },
    { role: 'assistant', content: '{"tool": "write_file", ...}', color: '#FFCD7E' },
    { role: 'tool', content: '✓ File created successfully', color: '#FFB5E4' },
    { role: 'assistant', content: 'I\'ve created the component...', color: '#FFCD7E' },
  ];

  return (
    <div className="w-full max-w-2xl mx-auto">
      <motion.div
        className="bg-card border rounded-2xl p-6 font-mono text-sm"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.2 }}
      >
        <div className="text-muted-foreground mb-4">messages = [</div>
        <div className="space-y-3 pl-4">
          {messages.map((msg, i) => (
            <motion.div
              key={i}
              className="flex items-start gap-3"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.3 + i * 0.1 }}
            >
              <div
                className="px-2 py-1 rounded text-xs font-semibold text-black shrink-0"
                style={{ backgroundColor: msg.color }}
              >
                {msg.role}
              </div>
              <div className="text-foreground/70 text-xs truncate">{`"${msg.content}"`}</div>
            </motion.div>
          ))}
        </div>
        <div className="text-muted-foreground mt-4">]</div>
      </motion.div>
      <motion.p
        className="text-center text-muted-foreground text-sm mt-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8 }}
      >
        Every interaction adds to this array → LLM sees full history
      </motion.p>
    </div>
  );
};

// Interactive Demo Component
const InteractiveDemo = () => {
  const [step, setStep] = useState(0);
  const maxSteps = 6;

  const nextStep = useCallback(() => {
    setStep((s) => Math.min(s + 1, maxSteps));
  }, []);

  const prevStep = useCallback(() => {
    setStep((s) => Math.max(s - 1, 0));
  }, []);

  // Handle keyboard navigation within the demo
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        nextStep();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        prevStep();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [nextStep, prevStep]);

  return (
    <div className="w-full max-w-5xl mx-auto px-4">
      {/* Progress indicator */}
      <div className="flex justify-center gap-1.5 mb-6">
        {Array.from({ length: maxSteps + 1 }).map((_, i) => (
          <button
            key={i}
            onClick={() => setStep(i)}
            className={cn(
              "w-2 h-2 rounded-full transition-all",
              i === step ? "bg-white w-6" : i < step ? "bg-white/60" : "bg-white/20"
            )}
          />
        ))}
      </div>

      <div className="relative min-h-[420px]">
        {/* Step 0: The function signature */}
        <AnimatePresence mode="wait">
          {step >= 0 && (
            <motion.div
              key="function"
              className="mb-6"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
            >
              <div className="bg-card border border-border/50 rounded-2xl p-5 font-mono inline-block">
                <span className="text-[#9DC2FF]">async def </span>
                <span className="text-white">run_agent</span>
                <span className="text-white/60">(</span>
                <span className={cn("transition-colors duration-300", step >= 1 ? "text-[#82DD95]" : "text-white/80")}>messages</span>
                <span className="text-white/60">, </span>
                <span className={cn("transition-colors duration-300", step >= 4 ? "text-[#FFCD7E]" : "text-white/80")}>tools</span>
                <span className="text-white/60">, </span>
                <span className={cn("transition-colors duration-300", step >= 5 ? "text-[#FFB5E4]" : "text-white/80")}>model</span>
                <span className="text-white/60">)</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Step 1-3: Messages breakdown */}
        {step >= 1 && (
          <motion.div
            className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
          >
            {/* Messages explanation */}
            <div className="bg-card border border-[#82DD95]/30 rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-3 h-3 rounded-full bg-[#82DD95]" />
                <span className="font-semibold text-[#82DD95]">messages[]</span>
                <span className="text-muted-foreground text-sm">— the worker&apos;s context / state</span>
              </div>
              
              <div className="space-y-2 font-mono text-sm">
                <motion.div 
                  className={cn("flex items-center gap-2 p-2 rounded-lg transition-colors", step >= 2 ? "bg-[#9DC2FF]/10" : "")}
                  animate={{ scale: step === 2 ? 1.02 : 1 }}
                >
                  <span className="px-2 py-0.5 rounded bg-[#9DC2FF] text-black text-xs font-bold">system</span>
                  <span className="text-white/70 text-xs">Worker persona & instructions</span>
                </motion.div>
                
                <motion.div 
                  className={cn("flex items-center gap-2 p-2 rounded-lg transition-colors", step >= 2 ? "bg-[#82DD95]/10" : "")}
                  animate={{ scale: step === 2 ? 1.02 : 1 }}
                >
                  <span className="px-2 py-0.5 rounded bg-[#82DD95] text-black text-xs font-bold">user</span>
                  <span className="text-white/70 text-xs">Any user input / request</span>
                </motion.div>
                
                <motion.div 
                  className={cn("flex items-center gap-2 p-2 rounded-lg transition-colors", step >= 3 ? "bg-[#FFCD7E]/10" : "")}
                  animate={{ scale: step === 3 ? 1.02 : 1 }}
                >
                  <span className="px-2 py-0.5 rounded bg-[#FFCD7E] text-black text-xs font-bold">assistant</span>
                  <span className="text-white/70 text-xs">LLM output (text or tool calls)</span>
                </motion.div>
                
                <motion.div 
                  className={cn("flex items-center gap-2 p-2 rounded-lg transition-colors", step >= 3 ? "bg-[#FFB5E4]/10" : "")}
                  animate={{ scale: step === 3 ? 1.02 : 1 }}
                >
                  <span className="px-2 py-0.5 rounded bg-[#FFB5E4] text-black text-xs font-bold">tool</span>
                  <span className="text-white/70 text-xs">Tool execution result</span>
                </motion.div>
              </div>
            </div>

            {/* Tools explanation */}
            {step >= 4 && (
              <motion.div
                className="bg-card border border-[#FFCD7E]/30 rounded-2xl p-5"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.4 }}
              >
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-3 h-3 rounded-full bg-[#FFCD7E]" />
                  <span className="font-semibold text-[#FFCD7E]">tools[]</span>
                  <span className="text-muted-foreground text-sm">— actions the agent can take</span>
                </div>
                
                <div className="font-mono text-xs bg-black/30 rounded-lg p-3 mb-3">
                  <div className="text-white/50">{"{"}</div>
                  <div className="pl-3">
                    <span className="text-[#9DC2FF]">&quot;name&quot;</span>: <span className="text-[#82DD95]">&quot;create_file&quot;</span>,
                  </div>
                  <div className="pl-3">
                    <span className="text-[#9DC2FF]">&quot;parameters&quot;</span>: {"{ ... }"}
                  </div>
                  <div className="text-white/50">{"}"}</div>
                </div>
                
                <p className="text-xs text-muted-foreground">
                  LLM outputs tokens in <span className="text-[#FFCD7E]">JSON</span> or <span className="text-[#FFCD7E]">XML</span> format → we parse & execute real code
                </p>
              </motion.div>
            )}
          </motion.div>
        )}

        {/* Step 5: Model */}
        {step >= 5 && (
          <motion.div
            className="mb-6"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <div className="inline-flex items-center gap-3 bg-card border border-[#FFB5E4]/30 rounded-xl px-4 py-2">
              <div className="w-3 h-3 rounded-full bg-[#FFB5E4]" />
              <span className="font-semibold text-[#FFB5E4]">model</span>
              <span className="text-muted-foreground">=</span>
              <span className="font-mono text-white">&quot;gpt-5&quot;</span>
              <span className="text-muted-foreground text-sm">or opus-4.5, etc.</span>
            </div>
          </motion.div>
        )}

        {/* Step 6: The Loop */}
        {step >= 6 && (
          <motion.div
            className="bg-gradient-to-r from-[#9DC2FF]/10 via-[#82DD95]/10 to-[#FFCD7E]/10 border border-white/10 rounded-2xl p-5 mb-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            <h4 className="font-semibold mb-4 text-center">The Loop</h4>
            <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
              <motion.div 
                className="px-3 py-1.5 rounded-lg bg-[#9DC2FF] text-black font-medium"
                animate={{ scale: [1, 1.05, 1] }}
                transition={{ duration: 2, repeat: Infinity, delay: 0 }}
              >
                Call LLM
              </motion.div>
              <ArrowRight className="w-4 h-4 text-white/40" />
              <motion.div 
                className="px-3 py-1.5 rounded-lg bg-[#FFCD7E] text-black font-medium"
                animate={{ scale: [1, 1.05, 1] }}
                transition={{ duration: 2, repeat: Infinity, delay: 0.5 }}
              >
                Parse for Tool Calls
              </motion.div>
              <ArrowRight className="w-4 h-4 text-white/40" />
              <motion.div 
                className="px-3 py-1.5 rounded-lg bg-[#82DD95] text-black font-medium"
                animate={{ scale: [1, 1.05, 1] }}
                transition={{ duration: 2, repeat: Infinity, delay: 1 }}
              >
                Execute Tools
              </motion.div>
              <ArrowRight className="w-4 h-4 text-white/40" />
              <motion.div 
                className="px-3 py-1.5 rounded-lg bg-[#FFB5E4] text-black font-medium"
                animate={{ scale: [1, 1.05, 1] }}
                transition={{ duration: 2, repeat: Infinity, delay: 1.5 }}
              >
                Add to History
              </motion.div>
              <ArrowRight className="w-4 h-4 text-white/40" />
              <motion.div 
                className="px-3 py-1.5 rounded-lg border border-dashed border-white/30 text-white/70 font-medium"
                animate={{ scale: [1, 1.05, 1] }}
                transition={{ duration: 2, repeat: Infinity, delay: 0 }}
              >
                Repeat ↩
              </motion.div>
            </div>
          </motion.div>
        )}

      </div>

      {/* Navigation hint */}
      <motion.p
        className="text-center text-muted-foreground text-xs mt-6"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1 }}
      >
        Press <span className="px-1.5 py-0.5 bg-white/10 rounded text-white/80">↓</span> or <span className="px-1.5 py-0.5 bg-white/10 rounded text-white/80">Space</span> to advance • <span className="px-1.5 py-0.5 bg-white/10 rounded text-white/80">↑</span> to go back
      </motion.p>
    </div>
  );
};

// Kortix Stack Diagram
const KortixStackDiagram = () => {
  const layers = [
    { label: 'User Interface', color: '#9DC2FF', width: '100%' },
    { label: 'Worker Orchestration', color: '#82DD95', width: '90%' },
    { label: 'Tool Execution Layer', color: '#FFCD7E', width: '80%' },
    { label: 'Sandboxed Environment', color: '#FFB5E4', width: '70%' },
    { label: 'LLM Foundation', color: '#FFAFAF', width: '60%' },
  ];

  return (
    <div className="w-full max-w-xl mx-auto space-y-3">
      {layers.map((layer, i) => (
        <motion.div
          key={i}
          className="mx-auto rounded-xl py-4 px-6 text-center font-medium text-black"
          style={{ backgroundColor: layer.color, width: layer.width }}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.12, type: 'spring' }}
        >
          {layer.label}
        </motion.div>
      ))}
    </div>
  );
};

// Sandbox Architecture Diagram
const SandboxArchDiagram = () => {
  const layers = [
    { label: 'User Request', sublabel: '"Build me a landing page"', color: '#9DC2FF', icon: '💬' },
    { label: 'Worker Orchestration', sublabel: 'ThreadManager → run_agent()', color: '#82DD95', icon: '🧠' },
    { label: 'Tool Execution', sublabel: 'sb_files, sb_shell, browser', color: '#FFCD7E', icon: '🔧' },
    { label: 'Sandboxed Container', sublabel: 'Isolated Linux environment', color: '#FFB5E4', icon: '📦' },
  ];

  return (
    <div className="w-full max-w-2xl mx-auto space-y-4">
      {layers.map((layer, i) => (
        <motion.div
          key={i}
          className="relative"
          initial={{ opacity: 0, x: -30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: i * 0.15, type: 'spring' }}
        >
          <div
            className="rounded-2xl py-5 px-6 flex items-center gap-4"
            style={{ backgroundColor: layer.color }}
          >
            <span className="text-2xl">{layer.icon}</span>
            <div>
              <div className="font-semibold text-black">{layer.label}</div>
              <div className="text-sm text-black/60 font-mono">{layer.sublabel}</div>
            </div>
          </div>
          {i < layers.length - 1 && (
            <div className="flex justify-center py-1">
              <ArrowDown className="w-5 h-5 text-foreground/30" />
            </div>
          )}
        </motion.div>
      ))}
    </div>
  );
};

// Task Types Diagram
const TaskTypesDiagram = () => {
  const tasks = [
    { label: 'Bug fixes', x: 10, difficulty: 20, color: '#82DD95' },
    { label: 'Add feature', x: 25, difficulty: 35, color: '#82DD95' },
    { label: 'Refactor', x: 40, difficulty: 45, color: '#9DC2FF' },
    { label: 'New component', x: 55, difficulty: 55, color: '#9DC2FF' },
    { label: 'System design', x: 70, difficulty: 70, color: '#FFCD7E' },
    { label: 'Architecture', x: 85, difficulty: 85, color: '#FFAFAF' },
  ];

  return (
    <div className="w-full max-w-2xl mx-auto">
      <div className="relative h-64 bg-muted/20 rounded-2xl p-6 overflow-hidden">
        <div className="absolute inset-6 border-l border-b border-muted-foreground/20" />
        <div className="absolute left-2 top-1/2 -translate-y-1/2 -rotate-90 text-xs text-muted-foreground whitespace-nowrap">
          Complexity
        </div>
        <div className="absolute bottom-1 left-1/2 -translate-x-1/2 text-xs text-muted-foreground">
          Close-ended → Open-ended
        </div>
        <div className="absolute top-6 left-6 right-6 bottom-6">
          <div className="absolute inset-y-0 left-0 w-1/2 bg-green-500/5 border-r border-dashed border-green-500/30" />
          <div className="absolute inset-y-0 right-0 w-1/2 bg-amber-500/5" />
          <div className="absolute top-2 left-4 text-[10px] text-green-600 font-medium">AI excels</div>
          <div className="absolute top-2 right-4 text-[10px] text-amber-600 font-medium">Needs guidance</div>
        </div>
        {tasks.map((task, i) => (
          <motion.div
            key={i}
            className="absolute flex flex-col items-center"
            style={{
              left: `calc(${task.x}% - 20px)`,
              bottom: `calc(${task.difficulty}% - 15px)`,
            }}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.3 + i * 0.1, type: 'spring' }}
          >
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center shadow-sm"
              style={{ backgroundColor: task.color }}
            />
            <span className="text-[10px] mt-1 text-muted-foreground whitespace-nowrap font-medium">
              {task.label}
            </span>
          </motion.div>
        ))}
      </div>
    </div>
  );
};


// Slide component
const SlideContent = ({ slide }: { slide: Slide }) => {
  const variants = {
    enter: { opacity: 0, y: 40 },
    center: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -40 },
  };

  return (
    <motion.div
      className="absolute inset-0 flex flex-col items-center justify-center p-8 md:p-16"
      variants={variants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
    >
      {slide.type === 'event' && (
        <div className="text-center max-w-4xl">
          {/* Logo */}
          <motion.div
            className="flex items-center justify-center mb-12"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <Image
              src="/Logomark.svg"
              alt="Kortix"
              width={140}
              height={40}
              className="dark:invert h-10 w-auto"
            />
          </motion.div>

          <motion.h1
            className="text-5xl md:text-7xl lg:text-8xl font-semibold tracking-tight mb-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            {slide.title}
          </motion.h1>
          
          <motion.p
            className="text-xl md:text-2xl lg:text-3xl text-muted-foreground"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
          >
            {slide.subtitle}
          </motion.p>
        </div>
      )}

      {slide.type === 'speaker' && (
        <div className="text-center max-w-4xl">
          {/* Two speakers side by side */}
          <div className="flex items-center justify-center gap-8 md:gap-16 mb-10">
            {/* Marko */}
            <motion.div
              className="flex flex-col items-center"
              initial={{ scale: 0, x: -20 }}
              animate={{ scale: 1, x: 0 }}
              transition={{ delay: 0.2, type: 'spring' }}
            >
              <div className="w-32 h-32 md:w-44 md:h-44 rounded-full bg-gradient-to-br from-[#9DC2FF] via-[#82DD95] to-[#FFCD7E] p-1">
                <div className="w-full h-full rounded-full bg-card flex items-center justify-center overflow-hidden">
                  <div className="text-5xl md:text-6xl">👨‍💻</div>
                </div>
              </div>
              <h2 className="mt-4 text-xl md:text-2xl font-semibold">Marko Kraemer</h2>
              <p className="text-muted-foreground">CEO</p>
            </motion.div>

            {/* Domenico */}
            <motion.div
              className="flex flex-col items-center"
              initial={{ scale: 0, x: 20 }}
              animate={{ scale: 1, x: 0 }}
              transition={{ delay: 0.3, type: 'spring' }}
            >
              <div className="w-32 h-32 md:w-44 md:h-44 rounded-full bg-gradient-to-br from-[#FFB5E4] via-[#FFCD7E] to-[#82DD95] p-1">
                <div className="w-full h-full rounded-full bg-card flex items-center justify-center overflow-hidden">
                  <div className="text-5xl md:text-6xl">👨‍💼</div>
                </div>
              </div>
              <h2 className="mt-4 text-xl md:text-2xl font-semibold">Domenico Gagliardi</h2>
              <p className="text-muted-foreground">COO</p>
            </motion.div>
          </div>
        </div>
      )}

      {slide.type === 'title' && (
        <div className="text-center max-w-4xl">
          <motion.div
            className="w-20 h-20 mx-auto mb-8"
            initial={{ scale: 0, rotate: -10 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ delay: 0.2, type: 'spring' }}
          >
            <Image
              src="/kortix-symbol.svg"
              alt="Kortix"
              width={80}
              height={80}
              className="dark:invert w-full h-full"
            />
          </motion.div>
          <motion.h1
            className="text-4xl md:text-6xl lg:text-7xl font-semibold tracking-tight mb-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            {slide.title}
          </motion.h1>
          <motion.p
            className="text-xl md:text-2xl text-muted-foreground"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
          >
            {slide.subtitle}
          </motion.p>
        </div>
      )}

      {slide.type === 'content' && (
        <div className="w-full max-w-4xl">
          <div className="flex items-center gap-4 mb-12">
            <motion.div
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: slide.accent }}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.1 }}
            />
            <motion.h2
              className="text-3xl md:text-5xl font-semibold tracking-tight"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.15 }}
            >
              {slide.title}
            </motion.h2>
          </div>
          <ul className="space-y-6">
            {slide.bulletPoints?.map((point, i) => (
              <motion.li
                key={i}
                className="flex items-start gap-4 text-lg md:text-2xl"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.2 + i * 0.08 }}
              >
                <span
                  className="w-2 h-2 rounded-full mt-3 flex-shrink-0"
                  style={{ backgroundColor: slide.accent }}
                />
                <span className="text-foreground/90">{point}</span>
              </motion.li>
            ))}
          </ul>
        </div>
      )}

      {slide.type === 'diagram' && (
        <div className="w-full max-w-4xl">
          <div className="text-center mb-8">
            <motion.h2
              className="text-3xl md:text-5xl font-semibold tracking-tight mb-3"
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              {slide.title}
            </motion.h2>
            {slide.subtitle && (
              <motion.p
                className="text-lg md:text-xl text-muted-foreground"
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
              >
                {slide.subtitle}
              </motion.p>
            )}
          </div>
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.3 }}
          >
            {slide.diagram === 'agent-loop' && <AgentLoopDiagram />}
            {slide.diagram === 'kortix-stack' && <KortixStackDiagram />}
            {slide.diagram === 'task-types' && <TaskTypesDiagram />}
            {slide.diagram === 'token-flow' && <TokenFlowDiagram />}
            {slide.diagram === 'messages-array' && <MessagesArrayDiagram />}
            {slide.diagram === 'sandbox-arch' && <SandboxArchDiagram />}
          </motion.div>
        </div>
      )}

      {slide.type === 'code' && (
        <div className="w-full max-w-4xl">
          <div className="flex items-center gap-4 mb-6">
            <motion.div
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: slide.accent }}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.1 }}
            />
            <motion.h2
              className="text-2xl md:text-4xl font-semibold tracking-tight"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.15 }}
            >
              {slide.title}
            </motion.h2>
          </div>
          <motion.div
            className="bg-[#1a1a1a] rounded-2xl overflow-hidden border border-white/10"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            {slide.codeTitle && (
              <div className="px-4 py-2 bg-white/5 border-b border-white/10 flex items-center gap-2">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-red-500/80" />
                  <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                  <div className="w-3 h-3 rounded-full bg-green-500/80" />
                </div>
                <span className="text-xs text-white/50 ml-2 font-mono">{slide.codeTitle}</span>
              </div>
            )}
            <pre className="p-6 overflow-x-auto">
              <code className="text-sm md:text-base font-mono text-white/90 leading-relaxed whitespace-pre">
                {slide.codeSnippet}
              </code>
            </pre>
          </motion.div>
        </div>
      )}

      {slide.type === 'interactive' && (
        <div className="w-full">
          <motion.div
            className="text-center mb-8"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <h2 className="text-3xl md:text-5xl font-semibold tracking-tight mb-2">
              {slide.title}
            </h2>
            {slide.subtitle && (
              <p className="text-muted-foreground text-lg">{slide.subtitle}</p>
            )}
          </motion.div>
          <InteractiveDemo />
        </div>
      )}

      {slide.type === 'comparison' && (
        <div className="w-full max-w-5xl">
          <motion.h2
            className="text-3xl md:text-5xl font-semibold tracking-tight mb-12 text-center"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            {slide.title}
          </motion.h2>
          <div className="grid md:grid-cols-2 gap-8">
            {[slide.leftColumn, slide.rightColumn].map((column, colIndex) => (
              <motion.div
                key={colIndex}
                className="bg-card rounded-3xl p-8 border"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 + colIndex * 0.1 }}
              >
                <div
                  className="inline-block px-4 py-2 rounded-full text-sm font-medium mb-6"
                  style={{
                    backgroundColor: colIndex === 0 ? '#82DD95' : '#FFB5E4',
                    color: '#000',
                  }}
                >
                  {column?.title}
                </div>
                <ul className="space-y-4">
                  {column?.points.map((point, i) => (
                    <motion.li
                      key={i}
                      className="flex items-start gap-3 text-base md:text-lg"
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.4 + colIndex * 0.15 + i * 0.05 }}
                    >
                      <Circle
                        className="w-2 h-2 mt-2.5 flex-shrink-0"
                        fill={colIndex === 0 ? '#82DD95' : '#FFB5E4'}
                        stroke="none"
                      />
                      <span className="text-foreground/80">{point}</span>
                    </motion.li>
                  ))}
                </ul>
              </motion.div>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
};

// Progress indicator
const ProgressBar = ({ current, total }: { current: number; total: number }) => (
  <div className="fixed bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-2 z-50">
    {Array.from({ length: total }).map((_, i) => (
      <motion.div
        key={i}
        className={cn(
          'h-1.5 rounded-full transition-all duration-300',
          i === current ? 'w-8 bg-foreground' : 'w-1.5 bg-foreground/20'
        )}
        whileHover={{ scale: 1.2 }}
      />
    ))}
  </div>
);

// Navigation controls
const NavigationControls = ({
  onPrev,
  onNext,
  canPrev,
  canNext,
  currentSlide,
  totalSlides,
  isFullscreen,
  onToggleFullscreen,
}: {
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
  currentSlide: number;
  totalSlides: number;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}) => (
  <div className="fixed bottom-8 right-8 flex items-center gap-3 z-50">
    <span className="text-sm text-muted-foreground mr-2">
      {currentSlide + 1} / {totalSlides}
    </span>
    <button
      onClick={onPrev}
      disabled={!canPrev}
      className={cn(
        'w-10 h-10 rounded-xl flex items-center justify-center transition-all',
        canPrev
          ? 'bg-card border hover:bg-accent text-foreground'
          : 'bg-muted text-muted-foreground cursor-not-allowed'
      )}
    >
      <ChevronLeft className="w-5 h-5" />
    </button>
    <button
      onClick={onNext}
      disabled={!canNext}
      className={cn(
        'w-10 h-10 rounded-xl flex items-center justify-center transition-all',
        canNext
          ? 'bg-card border hover:bg-accent text-foreground'
          : 'bg-muted text-muted-foreground cursor-not-allowed'
      )}
    >
      <ChevronRight className="w-5 h-5" />
    </button>
    <button
      onClick={onToggleFullscreen}
      className="w-10 h-10 rounded-xl flex items-center justify-center bg-card border hover:bg-accent text-foreground transition-all ml-2"
    >
      {isFullscreen ? (
        <Minimize2 className="w-4 h-4" />
      ) : (
        <Maximize2 className="w-4 h-4" />
      )}
    </button>
  </div>
);

// Main presentation component
export default function Agents101Page() {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const goToNext = useCallback(() => {
    if (currentSlide < slides.length - 1) {
      setCurrentSlide((prev) => prev + 1);
    }
  }, [currentSlide]);

  const goToPrev = useCallback(() => {
    if (currentSlide > 0) {
      setCurrentSlide((prev) => prev - 1);
    }
  }, [currentSlide]);

  const toggleFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) {
      await containerRef.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      await document.exitFullscreen();
      setIsFullscreen(false);
    }
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        goToNext();
      } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
        e.preventDefault();
        goToPrev();
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goToNext, goToPrev, toggleFullscreen, isFullscreen]);

  // Fullscreen change listener
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Touch/swipe support
  const touchStartX = useRef(0);
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    const touchEndX = e.changedTouches[0].clientX;
    const diff = touchStartX.current - touchEndX;
    if (Math.abs(diff) > 50) {
      if (diff > 0) goToNext();
      else goToPrev();
    }
  };

  return (
    <div
      ref={containerRef}
      className="min-h-screen bg-background overflow-hidden relative select-none"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <GrainOverlay />
      
      {/* Logo */}
      <div className="fixed top-8 left-8 z-50">
        <Image
          src="/Logomark.svg"
          alt="Kortix"
          width={72}
          height={72}
          className="dark:invert"
        />
      </div>

      {/* Slides */}
      <div className="relative w-full h-screen">
        <AnimatePresence mode="wait">
          <SlideContent
            key={currentSlide}
            slide={slides[currentSlide]}
          />
        </AnimatePresence>
      </div>

      {/* Progress */}
      <ProgressBar current={currentSlide} total={slides.length} />

      {/* Navigation */}
      <NavigationControls
        onPrev={goToPrev}
        onNext={goToNext}
        canPrev={currentSlide > 0}
        canNext={currentSlide < slides.length - 1}
        currentSlide={currentSlide}
        totalSlides={slides.length}
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggleFullscreen}
      />

      {/* Keyboard hints */}
      <div className="fixed bottom-8 left-8 text-xs text-muted-foreground/50 z-50 hidden md:block">
        <span className="px-2 py-1 bg-muted/50 rounded mr-2">←→</span>
        <span>Navigate</span>
        <span className="px-2 py-1 bg-muted/50 rounded mx-2 ml-4">F</span>
        <span>Fullscreen</span>
      </div>
    </div>
  );
}
