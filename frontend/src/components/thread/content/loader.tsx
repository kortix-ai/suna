import React, { useState, useEffect } from 'react';

const TEXTS = ["Thinking", "Planning", "Strategising", "Analyzing", "Processing"];
const TYPE_DELAY = 100;
const ERASE_DELAY = 50;
const PAUSE_DELAY = 1000;

export const AgentLoader = () => {
  const [displayText, setDisplayText] = useState("");

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;
    let currentTextIndex = 0;
    let currentCharIndex = 0;

    const type = () => {
      const currentText = TEXTS[currentTextIndex];
      if (currentCharIndex < currentText.length) {
        setDisplayText(currentText.slice(0, currentCharIndex + 1));
        currentCharIndex++;
        timeoutId = setTimeout(type, TYPE_DELAY);
      } else {
        timeoutId = setTimeout(() => {
          currentCharIndex = currentText.length;
          erase();
        }, PAUSE_DELAY);
      }
    };

    const erase = () => {
      const currentText = TEXTS[currentTextIndex];
      if (currentCharIndex > 0) {
        currentCharIndex--;
        setDisplayText(currentText.slice(0, currentCharIndex));
        timeoutId = setTimeout(erase, ERASE_DELAY);
      } else {
        currentTextIndex = (currentTextIndex + 1) % TEXTS.length;
        currentCharIndex = 0;
        timeoutId = setTimeout(type, TYPE_DELAY);
      }
    };

    type();

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, []);

  return (
    <div className="flex py-2 items-center w-full">
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {displayText}
        <span className="animate-pulse">|</span>
      </span>
    </div>
  );
};

