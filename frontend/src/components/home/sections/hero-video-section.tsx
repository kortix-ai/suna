import { HeroVideoDialog } from "@/components/home/ui/hero-video-dialog";

export function HeroVideoSection() {
  return (
    <div className="relative px-6 mt-10">
      <div className="relative w-full max-w-3xl mx-auto shadow-xl rounded-2xl overflow-hidden">
        <HeroVideoDialog
          className="block dark:hidden"
          animationStyle="from-center"
          videoSrc="https://www.youtube.com/embed/Jnxq0osSg2c?si=k8ddEM8h8lver20s"
          thumbnailSrc="/thumbnail-light.png"
          thumbnailAlt="Hero Video"
        />
        <HeroVideoDialog
          className="hidden dark:block"
          animationStyle="from-center"
          videoSrc="https://www.youtube.com/embed/Jnxq0osSg2c?si=k8ddEM8h8lver20s"
          thumbnailSrc="/thumbnail-dark.png"
          thumbnailAlt="Hero Video"
        />
      </div>
    </div>
  );
}
