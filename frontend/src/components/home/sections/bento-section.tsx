'use client';

import { SectionHeader } from '@/components/home/section-header';
import { FirstBentoAnimation } from '@/components/home/first-bento-animation';
import { SecondBentoAnimation } from '@/components/home/second-bento-animation';
import { ThirdBentoAnimation } from '@/components/home/third-bento-animation';
export function BentoSection() {
  const bentoItems = [
    {
      id: 1,
      content: <FirstBentoAnimation />,
      title: 'Describe your needs',
      description:
        'Tell Kortix what you need and customize your AI worker for your use cases.',
    },
    {
      id: 2,
      content: <SecondBentoAnimation />,
      title: 'Connect 100s of tools',
      description:
        'Connect to your favorite tools and services with our extensive library of integrations.',
    },
    {
      id: 3,
      content: <ThirdBentoAnimation />,
      title: 'Deploy and personalize',
      description:
        'Watch your agent handle complex tasks and workflows with advanced AI reasoning.',
    },
  ];

  return (
    <section
      id="process"
      className="flex flex-col items-center justify-center w-full relative"
    >
      <div className="relative w-full px-6">
        <div className="max-w-6xl mx-auto border-l border-r border-border">
          <SectionHeader>
            <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance pb-1">
              Create a New AI Worker in 3 Simple Steps
            </h2>
            <p className="text-muted-foreground text-center text-balance font-medium">
              Customize powerful AI Workers to work on your tailored use cases.
            </p>
          </SectionHeader>

          <div className="grid grid-cols-1 md:grid-cols-3 overflow-hidden border-t">
          {bentoItems.map((item) => (
            <div
              key={item.id}
              className="flex flex-col items-start justify-end min-h-[600px] md:min-h-[500px] p-0.5 relative before:absolute before:-left-0.5 before:top-0 before:z-10 before:h-screen before:w-px before:bg-border before:content-[''] after:absolute after:-top-0.5 after:left-0 after:z-10 after:h-px after:w-screen after:bg-border after:content-[''] group cursor-pointer max-h-[400px] group"
            >
              <div className="relative flex size-full items-center justify-center h-full overflow-hidden">
                {item.content}
              </div>
              <div className="flex-1 flex-col gap-2 p-6">
                <h3 className="text-lg tracking-tighter font-semibold">
                  {item.title}
                </h3>
                <p className="text-muted-foreground">{item.description}</p>
              </div>
            </div>
          ))}
          </div>
        </div>
      </div>
    </section>
  );
}
