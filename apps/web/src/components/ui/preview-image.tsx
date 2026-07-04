"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { Minus, Plus } from "lucide-react";
import Image from "next/image";
import * as React from "react";

import { Icon } from "@/features/icon/icon";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { ButtonGroup } from "./button-group";

const PreviewImage = DialogPrimitive.Root;

const PreviewImageTrigger = DialogPrimitive.Trigger;

const PreviewImagePortal = DialogPrimitive.Portal;

const PreviewImageClose = DialogPrimitive.Close;

const PreviewImageOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "bg-primary/[0.99] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 dark:bg-background/[0.99] fixed inset-0 z-50",
      className,
    )}
    {...props}
  />
));
PreviewImageOverlay.displayName = DialogPrimitive.Overlay.displayName;

interface PreviewImageContentProps extends React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> {
  closeClassName?: string;
  previewClassName?: string;
  border?: boolean;
  fileType?: string;
  fileSrc?: string;
  fileContent?: string;
  fileName?: string;
  file?: File | string;
  fullscreen?: boolean;
}

const MIN_ZOOM = 0.7;
const DEFAULT_ZOOM = 1;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;
const DEFAULT_ORIGIN = "50% 50%";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const PreviewImageContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  PreviewImageContentProps
>(({ className, fileContent, fileName, ...props }, ref) => {
  const [zoomLevel, setZoomLevel] = React.useState(DEFAULT_ZOOM);
  const [transformOrigin, setTransformOrigin] = React.useState(DEFAULT_ORIGIN);

  const zoomPercent = Math.round(zoomLevel * 100);

  React.useEffect(() => {
    setZoomLevel(DEFAULT_ZOOM);
    setTransformOrigin(DEFAULT_ORIGIN);
  }, [fileContent]);

  const getTransformOrigin = (
    event: React.MouseEvent<HTMLDivElement> | React.WheelEvent<HTMLDivElement>,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return DEFAULT_ORIGIN;
    }

    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    const xPercent = clamp(x, 0, 100);
    const yPercent = clamp(y, 0, 100);

    return `${xPercent}% ${yPercent}%`;
  };

  const handleWheelZoom = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setTransformOrigin(getTransformOrigin(event));
    setZoomLevel((currentZoom) => {
      const nextZoom = event.deltaY < 0 ? currentZoom + ZOOM_STEP : currentZoom - ZOOM_STEP;
      return clamp(Number(nextZoom.toFixed(1)), MIN_ZOOM, MAX_ZOOM);
    });
  };

  const handleImageClick = (event: React.MouseEvent<HTMLDivElement>) => {
    setTransformOrigin(getTransformOrigin(event));
    setZoomLevel((currentZoom) => (currentZoom > DEFAULT_ZOOM ? DEFAULT_ZOOM : MAX_ZOOM));
  };

  const zoomOut = () => {
    setZoomLevel((currentZoom) =>
      clamp(Number((currentZoom - ZOOM_STEP).toFixed(1)), MIN_ZOOM, MAX_ZOOM),
    );
  };

  const zoomIn = () => {
    setZoomLevel((currentZoom) =>
      clamp(Number((currentZoom + ZOOM_STEP).toFixed(1)), MIN_ZOOM, MAX_ZOOM),
    );
  };

  const toggleZoom = () => {
    setZoomLevel((currentZoom) => (currentZoom > DEFAULT_ZOOM ? DEFAULT_ZOOM : MAX_ZOOM));
  };

  return (
    <PreviewImagePortal>
      <PreviewImageOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-[99999] grid h-full w-full -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-4 shadow-lg duration-200 sm:rounded-lg",
          className,
        )}
        {...props}
      >
        <VisuallyHidden.Root>
          <DialogPrimitive.Title>Image preview</DialogPrimitive.Title>
        </VisuallyHidden.Root>

        <div
          className="absolute top-2 right-2 z-[60] flex gap-1"
          onClick={(event) => event.stopPropagation()}
        >
          <ButtonGroup>
            <Button
              size="icon"
              type="button"
              onClick={zoomOut}
              className="text-background disabled:opacity-100"
              aria-label="Zoom out image"
              disabled={zoomLevel <= MIN_ZOOM}
            >
              <Minus className="size-4" />
            </Button>
            <Button
              size="magic-sm"
              type="button"
              onClick={toggleZoom}
              className="text-background h-8 font-mono text-sm"
            >
              {zoomPercent}%
            </Button>
            <Button
              size="icon"
              type="button"
              className="text-background disabled:opacity-100"
              onClick={zoomIn}
              aria-label="Zoom in image"
              disabled={zoomLevel >= MAX_ZOOM}
            >
              <Plus className="size-4" />
            </Button>
          </ButtonGroup>
          <PreviewImageClose asChild>
            <Button
              size="icon"
              type="button"
              aria-label="Close image preview"
              className="text-background"
            >
              <Icon.Close className="size-4" />
            </Button>
          </PreviewImageClose>
        </div>

        <div
          className="flex h-full max-h-[100vh] w-[100vw] items-center justify-center overflow-auto"
          onWheel={handleWheelZoom}
          onClick={handleImageClick}
        >
          <div
            className={cn(zoomLevel > DEFAULT_ZOOM ? "cursor-zoom-out" : "cursor-zoom-in")}
            style={{
              transform: `scale(${zoomLevel})`,
              transformOrigin,
              transition: "transform 200ms",
            }}
          >
            {fileContent ? (
              <Image
                src={fileContent}
                alt={fileName || "Image preview"}
                width={1920}
                height={1080}
                unoptimized
                className="max-h-[100vh] w-auto object-contain"
              />
            ) : null}
          </div>
        </div>
      </DialogPrimitive.Content>
    </PreviewImagePortal>
  );
});
PreviewImageContent.displayName = DialogPrimitive.Content.displayName;

const PreviewImageHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />
);
PreviewImageHeader.displayName = "PreviewImageHeader";

const PreviewImageFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
    {...props}
  />
);
PreviewImageFooter.displayName = "PreviewImageFooter";

const PreviewImageTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg leading-none font-semibold tracking-tight", className)}
    {...props}
  />
));
PreviewImageTitle.displayName = DialogPrimitive.Title.displayName;

const PreviewImageDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-muted-foreground text-sm", className)}
    {...props}
  />
));
PreviewImageDescription.displayName = DialogPrimitive.Description.displayName;

export {
  PreviewImage,
  PreviewImageClose,
  PreviewImageContent,
  PreviewImageDescription,
  PreviewImageFooter,
  PreviewImageHeader,
  PreviewImageOverlay,
  PreviewImagePortal,
  PreviewImageTitle,
  PreviewImageTrigger,
};
