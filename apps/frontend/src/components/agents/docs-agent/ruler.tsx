'use client'

import { useRef, useState } from "react";
import { FaCaretDown } from "react-icons/fa";

const markers = Array.from({ length: 83 }, (_, i) => i);

export const Ruler = () => {
    const [leftMargin, setLeftMargin] = useState(56);
    const [rightMargin, setRightMargin] = useState(56);

    const [isDraggingLeft, setIsDraggingLeft] = useState(false);
    const [isDraggingRight, setIsDraggingRight] = useState(false);
    const rulerRef = useRef<HTMLDivElement>(null);

    const handleLeftMouseDown = (event: React.MouseEvent) => {  
        setIsDraggingLeft(true);
    }
    
    const handleRightMouseDown = (event: React.MouseEvent) => {  
        setIsDraggingRight(true);

    }

    const handleMouseMove = (event: React.MouseEvent) => {
        if ((isDraggingLeft || isDraggingRight) && rulerRef.current) {
            const container = rulerRef.current.querySelector('#ruler-container');
            if(container) {
                const containerBox = container.getBoundingClientRect();
                const relativeX = event.clientX - containerBox.left;
                const rawPosition = Math.max(0, Math.min(816, relativeX));
                if(isDraggingLeft) {
                    const maxLeftPosition = 816 - rightMargin - 100;
                    const newLeftPosition = Math.min(rawPosition, maxLeftPosition);
                    setLeftMargin(newLeftPosition);
                } else if (isDraggingRight){
                    const maxRightPosition = 816 - (leftMargin + 100);
                    const newRightPosition = Math.max(816 - rawPosition, 0);
                    const finalRightPosition = Math.min(newRightPosition, maxRightPosition)
                    setRightMargin(finalRightPosition);
                }
            }
        }
    }

    const handleMouseUp = () => {
        setIsDraggingLeft(false);
        setIsDraggingRight(false);
    }

    const handleLeftDoubleClick = () => {
        setLeftMargin(56);
    }

    const handleRightDoubleClick = () => {
        setRightMargin(56);
    }

    return (
        <div ref={rulerRef} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} className="z-[99] h-6 border-b bg-muted/20 flex items-end relative select-none print:hidden">
          <div id="ruler-container" className="max-w-[816px] w-full h-full mx-auto relative">
            <Marker 
                position={leftMargin}
                isLeft={true}
                isDragging={isDraggingLeft}
                onMouseDown={handleLeftMouseDown}
                onDoubleClick={handleLeftDoubleClick}
            />
            <Marker 
                position={rightMargin}
                isLeft={false}
                isDragging={isDraggingRight}
                onMouseDown={handleRightMouseDown}
                onDoubleClick={handleRightDoubleClick}
            />
            <div id="ruler-markers" className="absolute inset-x-0 bottom-0 h-full">
              <div className="relative h-full w-[816px]">
                {markers.map((marker) => {
                  const position = (marker * 816) / 82
                  return (
                    <div key={marker} className="absolute bottom-0" style={{ left: `${position}px` }}>
                        {marker % 10 === 0 && (
                          <>
                            <div className="absolute bottom-0 w-[1px] h-2 bg-muted-foreground"/>
                            <span className="absolute bottom-2 text-[10px] text-xs text-muted-foreground transform -translate-x-1/2">
                                {marker / 10 + 1}
                            </span>
                          </>
                        )}
                        {marker % 5 === 0 && marker % 10 !== 0 && (
                          <>
                            <div className="absolute bottom-0 w-[1px] h-1.5 bg-muted-foreground"/>
                          </>
                        )}
                        {marker % 5 !== 0 && (
                          <>
                            <div className="absolute bottom-0 w-[1px] h-1 bg-muted-foreground"/>
                          </>
                        )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
    )
}

interface MarkerProps{
    position: number;
    isLeft: boolean;
    isDragging: boolean;
    onMouseDown: (event: React.MouseEvent) => void;
    onDoubleClick: (event: React.MouseEvent) => void;
}

const Marker = ({ position, isLeft, isDragging, onMouseDown, onDoubleClick }: MarkerProps) => {
    return (
        <div 
          className="absolute top-0 w-4 h-full cursor-ew-resize z-[5] group -ml-2" 
          style={{ [isLeft ? 'left' : 'right']: `${position}px` }}
          onMouseDown={onMouseDown}
          onDoubleClick={onDoubleClick}
        >
            <FaCaretDown className="absolute left-1/2 top-0 h-full fill-red-500 transform -translate-x-1/2" />
            <div
              className="absolute top-4 left-1/2 transform -translate-x-1/2"
              style={{
                height: "100vh",
                width: "1px",
                transform: "scaleX(0.5)",
                backgroundColor: "#3b72f6",
                display: isDragging ? "block" : "none",
              }}
            />
        </div>
    )
}