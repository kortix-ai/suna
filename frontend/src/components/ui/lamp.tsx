"use client";
import React from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

export default function LampDemo() {
  return (
    <LampContainer>
      <motion.h1
        initial={{ opacity: 0.5, y: 100 }}
        whileInView={{ opacity: 1, y: 0 }}
        transition={{
          delay: 0.3,
          duration: 0.8,
          ease: "easeInOut",
        }}
        className="mt-8 bg-gradient-to-br from-slate-300 to-slate-500 py-4 bg-clip-text text-center text-4xl font-medium tracking-tight text-transparent md:text-7xl"
      >
        Build lamps <br /> the right way
      </motion.h1>
    </LampContainer>
  );
}

export const LampContainer = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => {
  return (
    <div
      className={cn(
        "relative flex min-h-screen flex-col items-center justify-center overflow-hidden w-full rounded-md z-0",
        className
      )}
    >
      <div className="relative flex w-full flex-1 scale-y-125 items-center justify-center isolate z-0">
        {/* Left cone - positioned 25% from left */}
        <motion.div
          initial={{ opacity: 0.5, width: "15rem" }}
          whileInView={{ opacity: 1, width: "30rem" }}
          transition={{
            delay: 0.3,
            duration: 0.8,
            ease: "easeInOut",
          }}
          style={{
            backgroundImage: `conic-gradient(var(--conic-position), var(--tw-gradient-stops))`,
          }}
          className="absolute inset-auto left-[25%] h-56 overflow-visible w-[30rem] bg-gradient-conic from-cyan-500 via-transparent to-transparent text-white [--conic-position:from_70deg_at_center_top] -translate-x-1/2"
        >
          {/* Use transparent backgrounds with gradient masks instead of bg-background */}
          <div className="absolute w-[100%] left-0 h-40 bottom-0 z-20" 
            style={{
              background: 'linear-gradient(to top, hsl(var(--background)), transparent)',
              maskImage: 'linear-gradient(to top, white, transparent)',
              WebkitMaskImage: 'linear-gradient(to top, white, transparent)'
            }}
          />
          <div className="absolute w-40 h-[100%] left-0 bottom-0 z-20"
            style={{
              background: 'linear-gradient(to right, hsl(var(--background)), transparent)',
              maskImage: 'linear-gradient(to right, white, transparent)',
              WebkitMaskImage: 'linear-gradient(to right, white, transparent)'
            }}
          />
        </motion.div>
        
        {/* Right cone - positioned 25% from left (mirrored) */}
        <motion.div
          initial={{ opacity: 0.5, width: "15rem" }}
          whileInView={{ opacity: 1, width: "30rem" }}
          transition={{
            delay: 0.3,
            duration: 0.8,
            ease: "easeInOut",
          }}
          style={{
            backgroundImage: `conic-gradient(var(--conic-position), var(--tw-gradient-stops))`,
          }}
          className="absolute inset-auto left-[25%] h-56 w-[30rem] bg-gradient-conic from-transparent via-transparent to-cyan-500 text-white [--conic-position:from_290deg_at_center_top] translate-x-1/2"
        >
          <div className="absolute w-40 h-[100%] right-0 bottom-0 z-20"
            style={{
              background: 'linear-gradient(to left, hsl(var(--background)), transparent)',
              maskImage: 'linear-gradient(to left, white, transparent)',
              WebkitMaskImage: 'linear-gradient(to left, white, transparent)'
            }}
          />
          <div className="absolute w-[100%] right-0 h-40 bottom-0 z-20"
            style={{
              background: 'linear-gradient(to top, hsl(var(--background)), transparent)',
              maskImage: 'linear-gradient(to top, white, transparent)',
              WebkitMaskImage: 'linear-gradient(to top, white, transparent)'
            }}
          />
        </motion.div>
        
        {/* Background blur elements - using transparent gradient instead of bg-background */}
        <div className="absolute top-1/2 h-48 w-full translate-y-12 scale-x-150"
          style={{
            background: `radial-gradient(ellipse at center, hsl(var(--background) / 0.8) 0%, hsl(var(--background) / 0.6) 40%, transparent 70%)`,
            filter: 'blur(24px)'
          }}
        />
        <div className="absolute top-1/2 z-50 h-48 w-full bg-transparent opacity-10 backdrop-blur-md"></div>
        
        {/* Lamp bar - positioned between badge and heading, responsive for mobile */}
        <motion.div
          initial={{ width: "15rem" }}
          whileInView={{ width: "30rem" }}
          transition={{
            delay: 0.3,
            duration: 0.8,
            ease: "easeInOut",
          }}
          className="absolute inset-auto z-50 h-0.5 w-[30rem] -translate-y-[2rem] sm:-translate-y-[2.5rem] md:-translate-y-[3rem] lg:-translate-y-[3.5rem] left-1/2 -translate-x-1/2 pointer-events-none select-none outline-none"
          style={{
            background: 'linear-gradient(90deg, rgba(34, 211, 238, 0.8) 0%, rgba(34, 211, 238, 1) 50%, rgba(34, 211, 238, 0.8) 100%)',
            boxShadow: '0 0 20px rgba(34, 211, 238, 0.6), 0 0 40px rgba(34, 211, 238, 0.4)'
          }}
        ></motion.div>

        {/* Enhanced glow layers - larger and more prominent */}
        
        {/* Core glow - brightest and most focused */}
        <motion.div
          initial={{ width: "20rem", opacity: 0 }}
          whileInView={{ width: "35rem", opacity: 0.7 }}
          transition={{
            delay: 0.3,
            duration: 1.2,
            ease: "easeInOut",
          }}
          className="absolute inset-auto z-30 h-40 w-[35rem] -translate-y-[2rem] sm:-translate-y-[2.5rem] md:-translate-y-[3rem] lg:-translate-y-[3.5rem] left-1/2 -translate-x-1/2 rounded-full blur-xl pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse at center, rgba(34, 211, 238, 0.6) 0%, rgba(34, 211, 238, 0.4) 25%, rgba(34, 211, 238, 0.2) 50%, rgba(34, 211, 238, 0.08) 75%, transparent 90%)',
            maskImage: 'radial-gradient(ellipse at center, black 0%, rgba(0,0,0,0.8) 30%, rgba(0,0,0,0.4) 60%, transparent 100%)',
            WebkitMaskImage: 'radial-gradient(ellipse at center, black 0%, rgba(0,0,0,0.8) 30%, rgba(0,0,0,0.4) 60%, transparent 100%)'
          }}
        ></motion.div>

        {/* Mid glow - medium spread */}
        <motion.div
          initial={{ width: "30rem", opacity: 0 }}
          whileInView={{ width: "55rem", opacity: 0.5 }}
          transition={{
            delay: 0.3,
            duration: 1.5,
            ease: "easeInOut",
          }}
          className="absolute inset-auto z-20 h-60 w-[55rem] -translate-y-[2rem] sm:-translate-y-[2.5rem] md:-translate-y-[3rem] lg:-translate-y-[3.5rem] left-1/2 -translate-x-1/2 rounded-full blur-2xl pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse at center, rgba(34, 211, 238, 0.4) 0%, rgba(34, 211, 238, 0.25) 20%, rgba(34, 211, 238, 0.15) 40%, rgba(34, 211, 238, 0.06) 60%, rgba(34, 211, 238, 0.02) 80%, transparent 95%)',
            maskImage: 'radial-gradient(ellipse at center, black 0%, rgba(0,0,0,0.7) 25%, rgba(0,0,0,0.3) 50%, rgba(0,0,0,0.1) 75%, transparent 100%)',
            WebkitMaskImage: 'radial-gradient(ellipse at center, black 0%, rgba(0,0,0,0.7) 25%, rgba(0,0,0,0.3) 50%, rgba(0,0,0,0.1) 75%, transparent 100%)'
          }}
        ></motion.div>

        {/* Outer glow - large and diffuse */}
        <motion.div
          initial={{ width: "40rem", opacity: 0 }}
          whileInView={{ width: "80rem", opacity: 0.35 }}
          transition={{
            delay: 0.4,
            duration: 2.0,
            ease: "easeInOut",
          }}
          className="absolute inset-auto z-10 h-80 w-[80rem] -translate-y-[2rem] sm:-translate-y-[2.5rem] md:-translate-y-[3rem] lg:-translate-y-[3.5rem] left-1/2 -translate-x-1/2 rounded-full blur-3xl pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse at center, rgba(34, 211, 238, 0.25) 0%, rgba(34, 211, 238, 0.15) 15%, rgba(34, 211, 238, 0.08) 30%, rgba(34, 211, 238, 0.04) 45%, rgba(34, 211, 238, 0.02) 60%, transparent 85%)',
            maskImage: 'radial-gradient(ellipse at center, black 0%, rgba(0,0,0,0.6) 20%, rgba(0,0,0,0.2) 40%, rgba(0,0,0,0.05) 70%, transparent 100%)',
            WebkitMaskImage: 'radial-gradient(ellipse at center, black 0%, rgba(0,0,0,0.6) 20%, rgba(0,0,0,0.2) 40%, rgba(0,0,0,0.05) 70%, transparent 100%)'
          }}
        ></motion.div>

        {/* Atmospheric glow - extra large and subtle */}
        <motion.div
          initial={{ width: "60rem", opacity: 0 }}
          whileInView={{ width: "140rem", opacity: 0.25 }}
          transition={{
            delay: 0.5,
            duration: 2.5,
            ease: "easeInOut",
          }}
          className="absolute inset-auto z-5 h-[40rem] w-[140rem] -translate-y-[2rem] sm:-translate-y-[2.5rem] md:-translate-y-[3rem] lg:-translate-y-[3.5rem] left-1/2 -translate-x-1/2 rounded-full pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse at center, rgba(34, 211, 238, 0.15) 0%, rgba(34, 211, 238, 0.08) 10%, rgba(34, 211, 238, 0.04) 20%, rgba(34, 211, 238, 0.02) 30%, rgba(34, 211, 238, 0.01) 40%, transparent 65%)',
            maskImage: 'radial-gradient(ellipse at center, black 0%, rgba(0,0,0,0.5) 15%, rgba(0,0,0,0.1) 30%, rgba(0,0,0,0.02) 50%, transparent 80%)',
            WebkitMaskImage: 'radial-gradient(ellipse at center, black 0%, rgba(0,0,0,0.5) 15%, rgba(0,0,0,0.1) 30%, rgba(0,0,0,0.02) 50%, transparent 80%)',
            filter: 'blur(80px)'
          }}
        ></motion.div>

        {/* Ultra-wide atmospheric glow for seamless blending - even larger */}
        <motion.div
          initial={{ width: "80rem", opacity: 0 }}
          whileInView={{ width: "180rem", opacity: 0.18 }}
          transition={{
            delay: 0.6,
            duration: 3.0,
            ease: "easeInOut",
          }}
          className="absolute inset-auto z-0 h-[48rem] w-[180rem] -translate-y-[2rem] sm:-translate-y-[2.5rem] md:-translate-y-[3rem] lg:-translate-y-[3.5rem] left-1/2 -translate-x-1/2 rounded-full pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse at center, rgba(34, 211, 238, 0.08) 0%, rgba(34, 211, 238, 0.04) 8%, rgba(34, 211, 238, 0.02) 15%, rgba(34, 211, 238, 0.01) 25%, rgba(34, 211, 238, 0.005) 35%, transparent 55%)',
            maskImage: 'radial-gradient(ellipse at center, black 0%, rgba(0,0,0,0.3) 10%, rgba(0,0,0,0.05) 25%, rgba(0,0,0,0.01) 40%, transparent 70%)',
            WebkitMaskImage: 'radial-gradient(ellipse at center, black 0%, rgba(0,0,0,0.3) 10%, rgba(0,0,0,0.05) 25%, rgba(0,0,0,0.01) 40%, transparent 70%)',
            filter: 'blur(120px)'
          }}
        ></motion.div>
        
        {/* Top mask - using gradient instead of solid color */}
        <div className="absolute inset-auto z-40 h-44 w-full -translate-y-[16rem]"
          style={{
            background: `linear-gradient(to bottom, hsl(var(--background)), transparent)`
          }}
        />
      </div>

      <div className="relative z-50 flex -translate-y-80 flex-col items-center px-5">
        {children}
      </div>
    </div>
  );
};
