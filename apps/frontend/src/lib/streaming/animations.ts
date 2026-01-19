'use client';

import { useRef, useSyncExternalStore, useEffect, useLayoutEffect } from 'react';

const SMOOTH_STREAMING_ENABLED = false;

const CHARS_PER_SECOND = 600;
const MS_PER_CHAR = 1000 / CHARS_PER_SECOND;

class SmoothStreamStore {
  private targetText = '';
  private revealedLen = 0;
  private lastUpdateTime = 0;
  private animationId: number | null = null;
  private listeners = new Set<() => void>();
  private enabled = true;
  private isFinishingAnimation = false;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.revealedLen;

  private notify() {
    this.listeners.forEach(l => l());
  }

  private tick = () => {
    const now = performance.now();
    const targetLen = this.targetText.length;
    
    if (this.revealedLen >= targetLen) {
      this.animationId = null;
      this.isFinishingAnimation = false;
      return;
    }

    if (this.lastUpdateTime === 0) {
      this.lastUpdateTime = now;
    }

    const elapsed = now - this.lastUpdateTime;
    const charsToReveal = Math.floor(elapsed / MS_PER_CHAR);
    
    if (charsToReveal > 0) {
      this.revealedLen = Math.min(this.revealedLen + charsToReveal, targetLen);
      this.lastUpdateTime = now - (elapsed % MS_PER_CHAR);
      this.notify();
    }

    if (this.revealedLen < targetLen) {
      this.animationId = requestAnimationFrame(this.tick);
    } else {
      this.animationId = null;
      this.isFinishingAnimation = false;
    }
  };

  private startAnimation() {
    if (this.animationId !== null) return;
    this.lastUpdateTime = 0;
    this.animationId = requestAnimationFrame(this.tick);
  }

  private stopAnimation() {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  update(newText: string, isEnabled: boolean) {
    const wasEnabled = this.enabled;
    this.enabled = isEnabled;
    if (newText === this.targetText) {
      if (isEnabled && this.revealedLen < this.targetText.length) {
        this.startAnimation();
      }
      return;
    }
    
    if (!newText && this.targetText && this.revealedLen < this.targetText.length) {
      this.isFinishingAnimation = true;
      this.startAnimation();
      return;
    }
    if (!newText && this.isFinishingAnimation && this.targetText) {
      if (this.revealedLen < this.targetText.length) {
        this.startAnimation();
      }
      return;
    }

    if (!newText) {
      this.stopAnimation();
      this.targetText = '';
      this.revealedLen = 0;
      this.lastUpdateTime = 0;
      this.isFinishingAnimation = false;
      this.notify();
      return;
    }
    if (!isEnabled && wasEnabled) {
      this.isFinishingAnimation = true;
      this.targetText = newText;
      if (this.revealedLen < newText.length) {
        this.startAnimation();
      }
      return;
    }

    if (!isEnabled && this.isFinishingAnimation) {
      this.targetText = newText;
      if (this.revealedLen < newText.length) {
        this.startAnimation();
      }
      return;
    }

    if (!isEnabled) {
      this.stopAnimation();
      this.targetText = newText;
      this.revealedLen = newText.length;
      this.notify();
      return;
    }

    // Check if new text is a continuation (starts with current target)
    // OR if current target starts with new text (text was trimmed/partial - don't reset)
    const isContinuation = this.targetText.length > 0 && (
      newText.startsWith(this.targetText) || 
      this.targetText.startsWith(newText)
    );
    
    // Only reset if it's genuinely new/different content
    if (!isContinuation) {
      this.stopAnimation();
      this.revealedLen = 0;
      this.lastUpdateTime = 0;
      this.isFinishingAnimation = false;
    }
    
    this.targetText = newText;
    
    if (this.revealedLen < newText.length) {
      this.startAnimation();
    }
  }

  getText() {
    return this.targetText.slice(0, Math.min(this.revealedLen, this.targetText.length));
  }

  destroy() {
    this.stopAnimation();
    this.listeners.clear();
  }
}

export function useSmoothStream(
  text: string,
  enabled: boolean = true,
  _speed?: number
): string {
  const storeRef = useRef<SmoothStreamStore | null>(null);
  
  if (!storeRef.current) {
    storeRef.current = new SmoothStreamStore();
    storeRef.current.update(text, enabled);
  }
  
  const store = storeRef.current;
  
  useLayoutEffect(() => {
    store.update(text, enabled);
  }, [store, text, enabled]);
  
  useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );

  useEffect(() => {
    return () => {
      storeRef.current?.destroy();
    };
  }, []);

  if (!SMOOTH_STREAMING_ENABLED) {
    return text;
  }

  return store.getText();
}
