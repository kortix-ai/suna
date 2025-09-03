'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { Check, ArrowRight } from 'lucide-react';
import { GradientText } from '@/components/animate-ui/text/gradient';

interface InfoCardProps {
  title: string;
  description: string;
  avatar: string;
  avatar_color: string;
  tags: string[];
  keyPoints: string[];
  className?: string;
  enableTilt?: boolean;
}

export function InfoCard({
  title,
  description,
  avatar,
  avatar_color,
  tags,
  keyPoints,
  className,
  enableTilt = false,
}: InfoCardProps) {
  // Function to parse description and replace "AI" with GradientText
  const parseDescription = (text: string) => {
    return text.split('AI').map((part, index) => (
      <React.Fragment key={index}>
        {part}
        {index < text.split('AI').length - 1 && <GradientText text="AI" />}
      </React.Fragment>
    ));
  };
  const cardVariants = {
    initial: { 
      scale: 1, 
      rotateY: 0, 
      rotateX: 0,
      boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)"
    },
    hover: enableTilt ? { 
      scale: 1.03,
      rotateY: 8,
      rotateX: 4,
      boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
      transition: { duration: 0.4 }
    } : { 
      scale: 1.03,
      boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
      transition: { duration: 0.4 }
    },
  };

  const shimmerVariants = {
    initial: { x: "-100%" },
    hover: { 
      x: "100%",
      transition: { duration: 0.8 }
    }
  };

  return (
    <motion.div
      className={cn(
        "relative group cursor-default",
        "bg-card/70 backdrop-blur-md border border-border/60",
        "rounded-3xl p-4 sm:p-6 lg:p-7 h-full",
        "transition-all duration-500",
        "overflow-hidden",
        className
      )}
      variants={cardVariants}
      initial="initial"
      whileHover="hover"
      style={{
        transformStyle: "preserve-3d",
        perspective: 1000,
      }}
    >
      {/* Animated shimmer effect */}
      <motion.div
        className="absolute inset-0 z-0"
        variants={shimmerVariants}
        initial="initial"
        whileHover="hover"
        style={{
          background: `linear-gradient(90deg, transparent, ${avatar_color}20, transparent)`,
        }}
      />

      {/* Enhanced background gradient */}
      <div 
        className="absolute inset-0 opacity-10 rounded-3xl transition-opacity duration-500 group-hover:opacity-20"
        style={{
          background: `radial-gradient(circle at 20% 20%, ${avatar_color}40 0%, transparent 50%)`,
        }}
      />
      
      <div className="relative z-10 h-full flex flex-col">
        {/* Header */}
        <div className="flex items-start gap-3 sm:gap-4 lg:gap-5 mb-4 sm:mb-5 lg:mb-6">
          <motion.div 
            className="flex-shrink-0 w-12 h-12 sm:w-14 sm:h-14 rounded-2xl flex items-center justify-center text-xl sm:text-2xl font-medium shadow-lg transition-all duration-300 group-hover:scale-110"
            style={{ 
              backgroundColor: `${avatar_color}20`, 
              color: avatar_color,
              border: `2px solid ${avatar_color}30`
            }}
            whileHover={{ rotate: 10 }}
          >
            {avatar}
          </motion.div>
          
          <div className="flex-1 min-w-0">
            <h3 className="text-lg sm:text-xl font-bold text-foreground mb-2 sm:mb-3 leading-tight group-hover:text-opacity-90 transition-all duration-300">
              {title}
            </h3>
            
            {/* Tags */}
            <div className="flex flex-wrap gap-1.5 sm:gap-2">
              {tags.map((tag, index) => (
                <motion.span
                  key={index}
                  className="inline-flex items-center px-2 sm:px-3 py-1 sm:py-1.5 rounded-full text-xs font-semibold transition-all duration-300"
                  style={{ 
                    backgroundColor: `${avatar_color}15`,
                    color: avatar_color,
                    border: `1px solid ${avatar_color}25`
                  }}
                  whileHover={{ scale: 1.05 }}
                >
                  {tag}
                </motion.span>
              ))}
            </div>
          </div>
        </div>

        {/* Description */}
        <div className="mb-3 sm:mb-4 lg:mb-5">
          <p className="text-sm sm:text-sm text-muted-foreground leading-relaxed font-medium">
            {parseDescription(description)}
          </p>
        </div>

        {/* Key Points */}
        <div className="flex-1 space-y-2 sm:space-y-3">
          {keyPoints.map((point, index) => (
            <motion.div
              key={index}
              className="flex items-start gap-3 group/item"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.1 }}
            >
              <div 
                className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center mt-0.5 transition-all duration-300 group-hover/item:scale-110"
                style={{ backgroundColor: `${avatar_color}20` }}
              >
                <Check 
                  className="w-3 h-3 transition-all duration-300" 
                  style={{ color: avatar_color }}
                />
              </div>
              <span className="text-sm text-foreground/80 leading-relaxed font-medium group-hover/item:text-foreground transition-colors duration-300">
                {point}
              </span>
            </motion.div>
          ))}
        </div>

        {/* Enhanced hover indicator */}
        <motion.div 
          className="flex items-center gap-2 mt-3 sm:mt-4 text-xs font-semibold opacity-0 group-hover:opacity-100 transition-all duration-300"
          style={{ color: avatar_color }}
        >
          <span>Enterprise Ready</span>
          <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-1" />
        </motion.div>
      </div>

      {/* Enhanced border gradient */}
      <div 
        className="absolute inset-0 rounded-3xl pointer-events-none opacity-0 group-hover:opacity-40 transition-opacity duration-500"
        style={{
          background: `linear-gradient(135deg, ${avatar_color}60 0%, transparent 20%, transparent 80%, ${avatar_color}60 100%)`,
          maskImage: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          maskComposite: 'subtract',
          padding: '2px',
        }}
      />
    </motion.div>
  );
} 