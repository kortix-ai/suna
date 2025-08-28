import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AnimatedShinyText } from '@/components/ui/animated-shiny-text';

const items = [
    { id: 1, content: "Initializing neural pathways..." },
    { id: 2, content: "Analyzing query complexity..." },
    { id: 3, content: "Assembling cognitive framework..." },
    { id: 4, content: "Orchestrating thought processes..." },
    { id: 5, content: "Synthesizing contextual understanding..." },
    { id: 6, content: "Calibrating response parameters..." },
    { id: 7, content: "Engaging reasoning algorithms..." },
    { id: 8, content: "Processing semantic structures..." },
    { id: 9, content: "Formulating strategic approach..." },
    { id: 10, content: "Optimizing solution pathways..." },
    { id: 11, content: "Harmonizing data streams..." },
    { id: 12, content: "Architecting intelligent response..." },
    { id: 13, content: "Fine-tuning cognitive models..." },
    { id: 14, content: "Weaving narrative threads..." },
    { id: 15, content: "Crystallizing insights..." },
    { id: 16, content: "Preparing comprehensive analysis..." }
  ];

export const AgentLoader = () => {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setIndex((state) => {
        if (state >= items.length - 1) return 0;
        return state + 1;
      });
    }, 1500);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex py-2 items-center w-full">
      <div className="flex items-center gap-1">
        <div className="h-1 w-1 rounded-full bg-primary/40 animate-pulse duration-1000" />
        <div className="h-1 w-1 rounded-full bg-primary/40 animate-pulse duration-1000 delay-150" />
        <div className="h-1 w-1 rounded-full bg-primary/40 animate-pulse duration-1000 delay-300" />
      </div>
      <AnimatePresence>
      <motion.div
          key={items[index].id}
          initial={{ y: 20, opacity: 0, filter: "blur(8px)" }}
          animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
          exit={{ y: -20, opacity: 0, filter: "blur(8px)" }}
          transition={{ ease: "easeInOut" }}
          style={{ position: "absolute" }}
          className='ml-7'
      >
          <AnimatedShinyText className='text-xs'>{items[index].content}</AnimatedShinyText>
      </motion.div>
      </AnimatePresence>
    </div>
  );
};
