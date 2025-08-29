import { SectionHeader } from '@/components/home/section-header';
import { siteConfig } from '@/lib/home';

export function FeatureSection() {
  const steps = [
    {
      title: 'Ask Operator Directly',
      description: 'Speak or type your command—let Operator capture your intent. Your request instantly sets the process in motion.',
      icon: '1'
    },
    {
      title: 'Let Operator Process It',
      description: 'Watch as Operator analyzes your request, breaks it down into actionable steps, and begins executing your tasks.',
      icon: '2'
    },
    {
      title: 'Receive Instant, Actionable Results',
      description: 'Get comprehensive results delivered directly to you, complete with detailed insights and next steps.',
      icon: '3'
    },
    {
      title: 'Continuous Improvement',
      description: 'Operator learns from each interaction, continuously improving its performance and understanding of your needs.',
      icon: '4'
    }
  ];

  return (
    <section
      id="features"
      className="flex flex-col items-center justify-center gap-5 w-full relative py-20"
    >
      {/* Commented out Simple. Seamless. Smart. section */}
      {/* 
      <SectionHeader>
        <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance">
          Simple. Seamless. Smart.
        </h2>
        <p className="text-muted-foreground text-center text-balance font-medium">
          Discover how Operator transforms your commands into action in four easy steps
        </p>
      </SectionHeader>
      
      <div className="w-full max-w-7xl mx-auto px-6 mt-16">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
          {/* Left side - Steps */}
          {/*
          <div className="space-y-8">
            {steps.map((step, index) => (
              <div key={index} className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-secondary text-secondary-foreground rounded-full flex items-center justify-center font-semibold text-sm">
                  {step.icon}
                </div>
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold text-primary">{step.title}</h3>
                  <p className="text-muted-foreground leading-relaxed">{step.description}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Right side - Hero Image */}
          {/*
          <div className="relative">
            <div className="relative w-full h-96 bg-gradient-to-br from-gray-900 to-gray-800 rounded-2xl overflow-hidden border border-border">
              <img
                src="https://images.unsplash.com/photo-1419242902214-272b3f66ee7a?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=2400&q=80"
                alt="AI Agent in action"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent"></div>
              
              {/* Overlay figure */}
              {/*
              <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2">
                <div className="w-16 h-16 bg-background rounded-full flex items-center justify-center shadow-lg border border-border">
                  <svg className="w-8 h-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      */}
    </section>
  );
}
