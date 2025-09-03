import React from 'react';

interface OmniFallbackIconProps {
  size?: number;
  className?: string;
}

export const OmniFallbackIcon: React.FC<OmniFallbackIconProps> = ({ 
  size = 24, 
  className = "" 
}) => {
  return (
    <div className={`inline-flex items-center justify-center ${className}`} style={{ width: size, height: size }}>
      {/* Light version for dark mode, dark version for light mode */}
      <img
        src="/omni-ball-light.svg"
        alt="Omni"
        className="block dark:hidden w-full h-full"
        style={{ width: size, height: size }}
      />
      <img
        src="/omni-ball-dark.svg"
        alt="Omni"
        className="hidden dark:block w-full h-full"
        style={{ width: size, height: size }}
      />
    </div>
  );
};

export default OmniFallbackIcon;
