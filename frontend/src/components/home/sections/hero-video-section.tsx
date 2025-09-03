import { HeroVideoDialog } from '@/components/home/ui/hero-video-dialog';

export function HeroVideoSection() {
  return (
    <div className="relative px-4 sm:px-6 md:px-8">
      <div className="relative w-full max-w-4xl mx-auto shadow-2xl rounded-2xl md:rounded-3xl overflow-hidden">
        <HeroVideoDialog
          className="block dark:hidden"
          animationStyle="from-center"
          videoSrc="https://www.youtube.com/embed/dQw4w9WgXcQ"
          thumbnailSrc="/OMNI-Logo-light.png"
          thumbnailAlt="OMNI Hero Video"
        />
        <HeroVideoDialog
          className="hidden dark:block"
          animationStyle="from-center"
          videoSrc="https://www.youtube.com/embed/dQw4w9WgXcQ"
          thumbnailSrc="/OMNI-Logo-Dark.png"
          thumbnailAlt="OMNI Hero Video"
        />
      </div>
    </div>
  );
}
