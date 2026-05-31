// "use client";
// import { cn } from "@/lib/utils";
// import { AnimatePresence, motion, MotionConfig, Transition, Variant, Variants } from "motion/react";
// import * as React from "react";
// import { createContext, useContext, useEffect, useId, useState } from "react";

// export type DisclosureContextType = {
//   open: boolean;
//   toggle: () => void;
//   variants?: { expanded: Variant; collapsed: Variant };
// };

// const DisclosureContext = createContext<DisclosureContextType | undefined>(undefined);

// export type DisclosureProviderProps = {
//   children: React.ReactNode;
//   open: boolean;
//   onOpenChange?: (open: boolean) => void;
//   variants?: { expanded: Variant; collapsed: Variant };
// };

// function DisclosureProvider({
//   children,
//   open: openProp,
//   onOpenChange,
//   variants,
// }: DisclosureProviderProps) {
//   const [internalOpenValue, setInternalOpenValue] = useState<boolean>(openProp);

//   useEffect(() => {
//     setInternalOpenValue(openProp);
//   }, [openProp]);

//   const toggle = () => {
//     const newOpen = !internalOpenValue;
//     setInternalOpenValue(newOpen);
//     if (onOpenChange) {
//       onOpenChange(newOpen);
//     }
//   };

//   return (
//     <DisclosureContext.Provider
//       value={{
//         open: internalOpenValue,
//         toggle,
//         variants,
//       }}
//     >
//       {children}
//     </DisclosureContext.Provider>
//   );
// }

// function useDisclosure() {
//   const context = useContext(DisclosureContext);
//   if (!context) {
//     throw new Error("useDisclosure must be used within a DisclosureProvider");
//   }
//   return context;
// }

// export type DisclosureProps = {
//   open?: boolean;
//   onOpenChange?: (open: boolean) => void;
//   children: React.ReactNode;
//   className?: string;
//   variants?: { expanded: Variant; collapsed: Variant };
//   transition?: Transition;
// };

// export function Disclosure({
//   open: openProp = false,
//   onOpenChange,
//   children,
//   className,
//   transition,
//   variants,
// }: DisclosureProps) {
//   return (
//     <MotionConfig transition={transition}>
//       <div className={className}>
//         <DisclosureProvider open={openProp} onOpenChange={onOpenChange} variants={variants}>
//           {React.Children.toArray(children)[0]}
//           {React.Children.toArray(children)[1]}
//         </DisclosureProvider>
//       </div>
//     </MotionConfig>
//   );
// }

// export function DisclosureTrigger({
//   children,
//   className,
// }: {
//   children: React.ReactNode;
//   className?: string;
// }) {
//   const { toggle, open } = useDisclosure();

//   return (
//     <>
//       {React.Children.map(children, (child) => {
//         if (!React.isValidElement(child)) return child;

//         // Type the child element more specifically
//         type ButtonLikeProps = {
//           onClick?: React.MouseEventHandler;
//           role?: string;
//           "aria-expanded"?: boolean;
//           tabIndex?: number;
//           onKeyDown?: React.KeyboardEventHandler;
//           className?: string;
//           "data-state"?: string;
//         };

//         const typedChild = child as React.ReactElement<ButtonLikeProps>;
//         const childClassName = typedChild.props.className;

//         return React.cloneElement(typedChild, {
//           onClick: toggle,
//           role: "button",
//           "aria-expanded": open,
//           "data-state": open ? "open" : "closed",
//           tabIndex: 0,
//           onKeyDown: (e: React.KeyboardEvent) => {
//             if (e.key === "Enter" || e.key === " ") {
//               e.preventDefault();
//               toggle();
//             }
//           },
//           className: cn(className, childClassName),
//         });
//       })}
//     </>
//   );
// }

// export function DisclosureContent({
//   children,
//   className,
// }: {
//   children: React.ReactNode;
//   className?: string;
// }) {
//   const { open, variants } = useDisclosure();
//   const uniqueId = useId();

//   const BASE_VARIANTS: Variants = {
//     expanded: {
//       height: "auto",
//       opacity: 1,
//     },
//     collapsed: {
//       height: 0,
//       opacity: 0,
//     },
//   };

//   const combinedVariants = {
//     expanded: { ...BASE_VARIANTS.expanded, ...variants?.expanded },
//     collapsed: { ...BASE_VARIANTS.collapsed, ...variants?.collapsed },
//   };

//   return (
//     <div className={cn("overflow-hidden", className)}>
//       <AnimatePresence initial={false}>
//         {open && (
//           <motion.div
//             id={uniqueId}
//             initial="collapsed"
//             animate="expanded"
//             exit="collapsed"
//             variants={combinedVariants}
//           >
//             {children}
//           </motion.div>
//         )}
//       </AnimatePresence>
//     </div>
//   );
// }

// export default {
//   Disclosure,
//   DisclosureProvider,
//   DisclosureTrigger,
//   DisclosureContent,
// };

"use client";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion, MotionConfig, Transition, Variant, Variants } from "motion/react";
import * as React from "react";
import { createContext, useContext, useEffect, useId, useState } from "react";

export type DisclosureContextType = {
  open: boolean;
  toggle: () => void;
  variants?: { expanded: Variant; collapsed: Variant };
};

const DisclosureContext = createContext<DisclosureContextType | undefined>(undefined);

export type DisclosureProviderProps = {
  children: React.ReactNode;
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  variants?: { expanded: Variant; collapsed: Variant };
};

function DisclosureProvider({
  children,
  open: openProp,
  onOpenChange,
  variants,
}: DisclosureProviderProps) {
  const [internalOpenValue, setInternalOpenValue] = useState<boolean>(openProp);

  useEffect(() => {
    setInternalOpenValue(openProp);
  }, [openProp]);

  const toggle = () => {
    const newOpen = !internalOpenValue;
    setInternalOpenValue(newOpen);
    if (onOpenChange) {
      onOpenChange(newOpen);
    }
  };

  return (
    <DisclosureContext.Provider
      value={{
        open: internalOpenValue,
        toggle,
        variants,
      }}
    >
      {children}
    </DisclosureContext.Provider>
  );
}

function useDisclosure() {
  const context = useContext(DisclosureContext);
  if (!context) {
    throw new Error("useDisclosure must be used within a DisclosureProvider");
  }
  return context;
}

export type DisclosureProps = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
  variants?: { expanded: Variant; collapsed: Variant };
  transition?: Transition;
  variant?: "default" | "outline";
};

function DisclosureRoot({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const { open } = useDisclosure();
  return (
    <div className={className} data-state={open ? "open" : "closed"}>
      {children}
    </div>
  );
}

export function Disclosure({
  open: openProp = false,
  onOpenChange,
  children,
  className,
  transition,
  variants,
  variant = "default",
}: DisclosureProps) {
  return (
    <MotionConfig transition={transition}>
      <DisclosureProvider open={openProp} onOpenChange={onOpenChange} variants={variants}>
        <DisclosureRoot
          className={cn(
            variant === "outline" && "group border-border w-full rounded-lg border shadow-none",
            className,
          )}
        >
          {React.Children.toArray(children)[0]}
          {React.Children.toArray(children)[1]}
        </DisclosureRoot>
      </DisclosureProvider>
    </MotionConfig>
  );
}

export function DisclosureTrigger({
  children,
  className,
  variant = "default",
}: {
  children: React.ReactNode;
  className?: string;
  variant?: "default" | "outline";
}) {
  const { toggle, open } = useDisclosure();

  return (
    <>
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child;

        // Type the child element more specifically
        type ButtonLikeProps = {
          onClick?: React.MouseEventHandler;
          role?: string;
          "aria-expanded"?: boolean;
          tabIndex?: number;
          onKeyDown?: React.KeyboardEventHandler;
          className?: string;
        };

        const typedChild = child as React.ReactElement<ButtonLikeProps>;
        const childClassName = typedChild.props.className;

        return React.cloneElement(typedChild, {
          onClick: toggle,
          role: "button",
          "aria-expanded": open,
          tabIndex: 0,
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle();
            }
          },
          className: cn(
            className,
            childClassName,
            variant === "outline" &&
              "group-data-[state=open]:rounded-b-none group-data-[state=open]:border-b-0",
          ),
        });
      })}
    </>
  );
}

export function DisclosureContent({
  children,
  className,
  variant = "default",
}: {
  children: React.ReactNode;
  className?: string;
  variant?: "default" | "outline";
}) {
  const { open, variants } = useDisclosure();
  const uniqueId = useId();

  const BASE_VARIANTS: Variants = {
    expanded: {
      height: "auto",
      opacity: 1,
    },
    collapsed: {
      height: 0,
      opacity: 0,
    },
  };

  const combinedVariants = {
    expanded: { ...BASE_VARIANTS.expanded, ...variants?.expanded },
    collapsed: { ...BASE_VARIANTS.collapsed, ...variants?.collapsed },
  };

  return (
    <div
      className={cn(
        "overflow-hidden",
        // "group-data-[state=open]:rounded-b-lg group-data-[state=open]:border-x group-data-[state=open]:border-b group-data-[state=open]:border-border",
        // "group-data-[state=open]:rounded-lg group-data-[state=open]:rounded-t-lg",
        variant === "outline" && "group-data-[state=open]:rounded-b-lg",
        className,
      )}
    >
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={uniqueId}
            initial="collapsed"
            animate="expanded"
            exit="collapsed"
            variants={combinedVariants}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export type DisclosureBodyProps = {
  children: React.ReactNode;
  className?: string;
};

export function DisclosureBody({ children, className }: DisclosureBodyProps) {
  return <div className={cn("p-3 pt-0", className)}>{children}</div>;
}

export default {
  Disclosure,
  DisclosureBody,
  DisclosureProvider,
  DisclosureTrigger,
  DisclosureContent,
};
