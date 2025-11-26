import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { ToastComponent, Toast, ToastType } from './toast';

interface ToastContextType {
  toast: {
    error: (message: string) => void;
    success: (message: string) => void;
    info: (message: string) => void;
    warning: (message: string) => void;
  };
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [activeToast, setActiveToast] = useState<Toast | null>(null);
  const idRef = useRef(0);

  const show = useCallback((message: string, type: ToastType) => {
    idRef.current += 1;
    setActiveToast({ id: `${idRef.current}`, message, type });
  }, []);

  const toast = {
    error: (message: string) => show(message, 'error'),
    success: (message: string) => show(message, 'success'),
    info: (message: string) => show(message, 'info'),
    warning: (message: string) => show(message, 'warning'),
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        {activeToast && (
          <ToastComponent
            key={activeToast.id}
            toast={activeToast}
            onDismiss={() => setActiveToast(null)}
          />
        )}
      </View>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context.toast;
}
