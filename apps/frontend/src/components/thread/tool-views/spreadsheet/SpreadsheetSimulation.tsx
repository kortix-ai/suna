import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { useState, useEffect } from 'react';

interface SpreadsheetSimulationProps {
  mode?: 'mini' | 'max';
}

const COLS = 8;
const ROWS = 10;
const HEADER_COLOR = '#1F4E79';

export function SpreadsheetSimulation({ mode = 'max' }: SpreadsheetSimulationProps) {
  const [phase, setPhase] = useState(0);
  const [cursorPos, setCursorPos] = useState({ row: 0, col: 0 });
  const [filledCells, setFilledCells] = useState<Set<string>>(new Set());
  const [formattedHeaders, setFormattedHeaders] = useState(false);
  const [activeCell, setActiveCell] = useState<string | null>(null);
  const [typingCell, setTypingCell] = useState<string | null>(null);

  useEffect(() => {
    const sequence = async () => {
      await new Promise(r => setTimeout(r, 300));
      setPhase(1);

      for (let col = 0; col < COLS; col++) {
        setCursorPos({ row: 0, col });
        setActiveCell(`0-${col}`);
        await new Promise(r => setTimeout(r, 80));
        setTypingCell(`0-${col}`);
        await new Promise(r => setTimeout(r, 150));
        setFilledCells(prev => new Set([...prev, `0-${col}`]));
        setTypingCell(null);
      }

      await new Promise(r => setTimeout(r, 200));
      setFormattedHeaders(true);
      setPhase(2);

      for (let row = 1; row < ROWS - 1; row++) {
        for (let col = 0; col < COLS; col++) {
          setCursorPos({ row, col });
          setActiveCell(`${row}-${col}`);
          await new Promise(r => setTimeout(r, 40));
          setTypingCell(`${row}-${col}`);
          await new Promise(r => setTimeout(r, 60 + Math.random() * 40));
          setFilledCells(prev => new Set([...prev, `${row}-${col}`]));
          setTypingCell(null);
        }
      }

      setPhase(3);
      const lastRow = ROWS - 1;
      for (let col = 0; col < COLS; col++) {
        setCursorPos({ row: lastRow, col });
        setActiveCell(`${lastRow}-${col}`);
        await new Promise(r => setTimeout(r, 100));
        setTypingCell(`${lastRow}-${col}`);
        await new Promise(r => setTimeout(r, 200));
        setFilledCells(prev => new Set([...prev, `${lastRow}-${col}`]));
        setTypingCell(null);
      }

      setPhase(4);
      setActiveCell(null);
      
      await new Promise(r => setTimeout(r, 1500));
      setPhase(0);
      setFilledCells(new Set());
      setFormattedHeaders(false);
      setCursorPos({ row: 0, col: 0 });
    };

    sequence();
    const interval = setInterval(sequence, 8000);
    return () => clearInterval(interval);
  }, []);

  if (mode === 'mini') {
    return (
      <div className="flex items-center justify-center h-full w-full min-h-[200px]">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <motion.div 
              className="grid grid-cols-4 gap-1"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
            >
              {[...Array(16)].map((_, i) => (
                <motion.div
                  key={i}
                  className="h-6 w-10 rounded-sm bg-zinc-200 dark:bg-zinc-700"
                  animate={{
                    backgroundColor: i < 4 
                      ? [
                          'rgb(228 228 231)',
                          'rgb(31 78 121)',
                          'rgb(31 78 121)',
                        ]
                      : [
                          'rgb(228 228 231)',
                          'rgb(161 161 170)',
                          'rgb(228 228 231)',
                        ],
                  }}
                  transition={{
                    duration: 2,
                    repeat: Infinity,
                    delay: i * 0.1,
                  }}
                />
              ))}
            </motion.div>
            <motion.div
              className="absolute w-2 h-4 bg-emerald-500 rounded-sm"
              animate={{
                x: [0, 40, 80, 120, 0, 40, 80, 120],
                y: [0, 0, 0, 0, 24, 24, 24, 24],
              }}
              transition={{
                duration: 3,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            />
          </div>
          <motion.p 
            className="text-sm text-muted-foreground"
            animate={{ opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          >
            Building spreadsheet...
          </motion.p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex items-center justify-center p-8 bg-gradient-to-br from-zinc-50 to-zinc-100 dark:from-zinc-900 dark:to-zinc-950">
      <div className="w-full max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          <motion.div 
            className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden shadow-2xl shadow-zinc-200/50 dark:shadow-zinc-900/50"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1 }}
          >
            <div className="bg-white dark:bg-zinc-900">
              <div className="flex">
                <div className="w-10 bg-zinc-50 dark:bg-zinc-800/50 border-r border-zinc-200 dark:border-zinc-700" />
                <div className="flex-1 flex border-b border-zinc-200 dark:border-zinc-700">
                  {[...Array(COLS)].map((_, i) => (
                    <motion.div
                      key={i}
                      className="flex-1 h-6 border-r border-zinc-200 dark:border-zinc-700 flex items-center justify-center text-[10px] text-zinc-400 font-medium"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.3 + i * 0.03 }}
                    >
                      {String.fromCharCode(65 + i)}
                    </motion.div>
                  ))}
                </div>
              </div>

              {[...Array(ROWS)].map((_, rowIndex) => (
                <div key={rowIndex} className="flex">
                  <motion.div 
                    className="w-10 h-7 bg-zinc-50 dark:bg-zinc-800/50 border-r border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-center text-[10px] text-zinc-400 font-medium"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.3 + rowIndex * 0.02 }}
                  >
                    {rowIndex + 1}
                  </motion.div>
                  <div className="flex-1 flex">
                    {[...Array(COLS)].map((_, colIndex) => {
                      const cellKey = `${rowIndex}-${colIndex}`;
                      const isFilled = filledCells.has(cellKey);
                      const isActive = activeCell === cellKey;
                      const isTyping = typingCell === cellKey;
                      const isHeader = rowIndex === 0 && formattedHeaders;
                      const isFormula = rowIndex === ROWS - 1 && isFilled;

                      return (
                        <motion.div
                          key={colIndex}
                          className={cn(
                            "flex-1 h-7 border-r border-b border-zinc-200 dark:border-zinc-700 relative overflow-hidden",
                            isActive && "ring-2 ring-emerald-500 ring-inset z-10",
                          )}
                          initial={{ backgroundColor: 'transparent' }}
                          animate={{
                            backgroundColor: isHeader 
                              ? HEADER_COLOR
                              : isFilled 
                                ? 'rgba(16, 185, 129, 0.08)'
                                : 'transparent',
                          }}
                          transition={{ duration: 0.2 }}
                        >
                          <AnimatePresence>
                            {isTyping && (
                              <motion.div
                                className="absolute inset-0 flex items-center justify-center"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                              >
                                <motion.div
                                  className="w-0.5 h-4 bg-zinc-800 dark:bg-zinc-200"
                                  animate={{ opacity: [1, 0, 1] }}
                                  transition={{ duration: 0.5, repeat: Infinity }}
                                />
                              </motion.div>
                            )}
                          </AnimatePresence>

                          <AnimatePresence>
                            {isFilled && !isTyping && (
                              <motion.div
                                className="absolute inset-0 flex items-center px-1"
                                initial={{ opacity: 0, x: -5 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ duration: 0.15 }}
                              >
                                {isFormula ? (
                                  <motion.div
                                    className="h-1.5 bg-zinc-400 dark:bg-zinc-500 rounded-full"
                                    initial={{ width: 0 }}
                                    animate={{ width: '70%' }}
                                    transition={{ duration: 0.3 }}
                                  />
                                ) : (
                                  <motion.div
                                    className={cn(
                                      "h-1.5 rounded-full",
                                      isHeader 
                                        ? "bg-white/60" 
                                        : "bg-zinc-300 dark:bg-zinc-600"
                                    )}
                                    initial={{ width: 0 }}
                                    animate={{ width: `${40 + Math.random() * 50}%` }}
                                    transition={{ duration: 0.2 }}
                                  />
                                )}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="bg-zinc-100 dark:bg-zinc-800 border-t border-zinc-200 dark:border-zinc-700 px-2 py-1.5 flex gap-1">
              <motion.div
                className="px-3 py-1 text-[10px] bg-white dark:bg-zinc-900 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.5 }}
              >
                Sheet1
              </motion.div>
              <motion.div
                className="px-2 py-1 text-[10px] text-zinc-400 flex items-center"
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 1, 0.5, 1] }}
                transition={{ delay: 1, duration: 1 }}
              >
                +
              </motion.div>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}
