import { FirstBentoAnimation } from '@/components/home/first-bento-animation';
import { FourthBentoAnimation } from '@/components/home/fourth-bento-animation';
import { SecondBentoAnimation } from '@/components/home/second-bento-animation';
import { ThirdBentoAnimation } from '@/components/home/third-bento-animation';
import { FlickeringGrid } from '@/components/home/ui/flickering-grid';
import { Globe } from '@/components/home/ui/globe';
import { cn } from '@/lib/utils';
import { motion } from 'motion/react';
import { config } from '@/lib/config';

export const Highlight = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => {
  return (
    <span
      className={cn(
        'p-1 py-0.5 font-medium dark:font-semibold text-secondary',
        className,
      )}
    >
      {children}
    </span>
  );
};

export const BLUR_FADE_DELAY = 0.15;

interface UpgradePlan {
  /** @deprecated */
  hours: string;
  price: string;
  stripePriceId: string;
}

export interface PricingTier {
  name: string;
  price: string;
  yearlyPrice?: string; // Add yearly price support
  description: string;
  buttonText: string;
  buttonColor: string;
  isPopular: boolean;
  /** @deprecated */
  hours: string;
  features: string[];
  stripePriceId: string;
  yearlyStripePriceId?: string; // Add yearly price ID support
  monthlyCommitmentStripePriceId?: string; // Add monthly commitment with yearly commitment support
  upgradePlans: UpgradePlan[];
  hidden?: boolean; // Optional property to hide plans from display while keeping them in code
  billingPeriod?: 'monthly' | 'yearly'; // Add billing period support
  originalYearlyPrice?: string; // For showing crossed-out price
  discountPercentage?: number; // For showing discount badge
}

export const siteConfig = {
      name: 'Operator',
  description: 'The Generalist AI Worker that can act on your behalf.',
  cta: 'Start Free',
  url: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  keywords: ['AI Worker', 'Generalist AI', 'Open Source AI', 'Autonomous Agent'],
  links: {
    email: 'support@omnisciencelabs.com',
    linkedin: 'https://www.linkedin.com/company/become-omni',
    youtube: 'https://www.youtube.com/@BecomeOmni',
    // discord: 'https://discord.gg/kortixai',
    github: 'https://github.com/omniscience-labs/omni',
    instagram: 'https://instagram.com/omnisciencelabs',
  },
  nav: {
    links: [
      { id: 1, name: 'Home', href: '#hero' },
      { id: 2, name: 'Process', href: '#process' },
      // { id: 3, name: 'Use Cases', href: '#use-cases' },
      { id: 4, name: 'Enterprise', href: '#enterprise' },
      { id: 5, name: 'Pricing', href: '#pricing' },
      { id: 6, name: 'Solutions', href: '/enterprise' },
    ],
  },
  hero: {
    badgeIcon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="text-muted-foreground"
      >
        <path
          d="M7.62758 1.09876C7.74088 1.03404 7.8691 1 7.99958 1C8.13006 1 8.25828 1.03404 8.37158 1.09876L13.6216 4.09876C13.7363 4.16438 13.8316 4.25915 13.8979 4.37347C13.9642 4.48779 13.9992 4.6176 13.9992 4.74976C13.9992 4.88191 13.9642 5.01172 13.8979 5.12604C13.8316 5.24036 13.7363 5.33513 13.6216 5.40076L8.37158 8.40076C8.25828 8.46548 8.13006 8.49952 7.99958 8.49952C7.8691 8.49952 7.74088 8.46548 7.62758 8.40076L2.37758 5.40076C2.26287 5.33513 2.16753 5.24036 2.10123 5.12604C2.03492 5.01172 2 4.88191 2 4.74976C2 4.6176 2.03492 4.48779 2.10123 4.37347C2.16753 4.25915 2.26287 4.16438 2.37758 4.09876L7.62758 1.09876Z"
          stroke="currentColor"
          strokeWidth="1.25"
        />
        <path
          d="M2.56958 7.23928L2.37758 7.34928C2.26287 7.41491 2.16753 7.50968 2.10123 7.624C2.03492 7.73831 2 7.86813 2 8.00028C2 8.13244 2.03492 8.26225 2.10123 8.37657C2.16753 8.49089 2.26287 8.58566 2.37758 8.65128L7.62758 11.6513C7.74088 11.716 7.8691 11.75 7.99958 11.75C8.13006 11.75 8.25828 11.716 8.37158 11.6513L13.6216 8.65128C13.7365 8.58573 13.8321 8.49093 13.8986 8.3765C13.965 8.26208 14 8.13211 14 7.99978C14 7.86745 13.965 7.73748 13.8986 7.62306C13.8321 7.50864 13.7365 7.41384 13.6216 7.34828L13.4296 7.23828L9.11558 9.70328C8.77568 9.89744 8.39102 9.99956 7.99958 9.99956C7.60814 9.99956 7.22347 9.89744 6.88358 9.70328L2.56958 7.23928Z"
          stroke="currentColor"
          strokeWidth="1.25"
        />
        <path
          d="M2.37845 10.5993L2.57045 10.4893L6.88445 12.9533C7.22435 13.1474 7.60901 13.2496 8.00045 13.2496C8.39189 13.2496 8.77656 13.1474 9.11645 12.9533L13.4305 10.4883L13.6225 10.5983C13.7374 10.6638 13.833 10.7586 13.8994 10.8731C13.9659 10.9875 14.0009 11.1175 14.0009 11.2498C14.0009 11.3821 13.9659 11.5121 13.8994 11.6265C13.833 11.7409 13.7374 11.8357 13.6225 11.9013L8.37245 14.9013C8.25915 14.966 8.13093 15 8.00045 15C7.86997 15 7.74175 14.966 7.62845 14.9013L2.37845 11.9013C2.2635 11.8357 2.16795 11.7409 2.10148 11.6265C2.03501 11.5121 2 11.3821 2 11.2498C2 11.1175 2.03501 10.9875 2.10148 10.8731C2.16795 10.7586 2.2635 10.6638 2.37845 10.5983V10.5993Z"
          stroke="currentColor"
          strokeWidth="1.25"
        />
      </svg>
    ),
    badge: '100% OPEN SOURCE',
    githubUrl: 'https://github.com/omniscience-labs/omni',
    title: 'Omni – Build, manage and train your AI Workforce.',
    description:
      'Omni – open-source platform to build, manage and train your AI Workforce.',
    inputPlaceholder: 'Ask Omni to...',
  },
  cloudPricingItems: [
    {
      name: 'Free',
      price: '$0',
      description: 'Perfect for getting started',
      buttonText: 'Start Free',
      buttonColor: 'bg-secondary text-white',
      isPopular: false,
      /** @deprecated */
      hours: '60 min',
      features: [
        '$5 free AI tokens included',
        '2 custom agents',
        'Public projects',
        'Basic Models',
        'Community support',
      ],
      stripePriceId: config.SUBSCRIPTION_TIERS.FREE.priceId,
      upgradePlans: [],
    },
    {
      name: 'Plus',
      price: '$20',
      yearlyPrice: '$204',
      originalYearlyPrice: '$240',
      discountPercentage: 15,
      description: 'Best for individuals and small teams',
      buttonText: 'Start Free',
      buttonColor: 'bg-primary text-white dark:text-black',
      isPopular: true,
      /** @deprecated */
      hours: '2 hours',
      features: [
        '$20 AI token credits/month',
        '5 custom agents',
        'Private projects',
        'Premium AI Models',
        'Community support',
      ],
      stripePriceId: config.SUBSCRIPTION_TIERS.TIER_2_20.priceId,
      yearlyStripePriceId: config.SUBSCRIPTION_TIERS.TIER_2_20_YEARLY.priceId,
      monthlyCommitmentStripePriceId: config.SUBSCRIPTION_TIERS.TIER_2_17_YEARLY_COMMITMENT.priceId,
      upgradePlans: [],
    },
    {
      name: 'Pro',
      price: '$50',
      yearlyPrice: '$510',
      originalYearlyPrice: '$600',
      discountPercentage: 15,
      description: 'Ideal for growing businesses',
      buttonText: 'Start Free',
      buttonColor: 'bg-secondary text-white',
      isPopular: false,
      /** @deprecated */
      hours: '6 hours',
      features: [
        '$50 AI token credits/month',
        '20 custom agents',
        'Private projects',
        'Premium AI Models',
        'Community support',
      ],
      stripePriceId: config.SUBSCRIPTION_TIERS.TIER_6_50.priceId,
      yearlyStripePriceId: config.SUBSCRIPTION_TIERS.TIER_6_50_YEARLY.priceId,
      monthlyCommitmentStripePriceId: config.SUBSCRIPTION_TIERS.TIER_6_42_YEARLY_COMMITMENT.priceId,
      upgradePlans: [],
    },
    {
      name: 'Business',
      price: '$100',
      yearlyPrice: '$1020',
      originalYearlyPrice: '$1200',
      discountPercentage: 15,
      description: 'For established businesses',
      buttonText: 'Start Free',
      buttonColor: 'bg-secondary text-white',
      isPopular: false,
      hours: '12 hours',
      features: [
        '$100 AI token credits/month',
        '20 custom agents',
        'Private projects',
        'Premium AI Models',
        'Community support',
      ],
      stripePriceId: config.SUBSCRIPTION_TIERS.TIER_12_100.priceId,
      yearlyStripePriceId: config.SUBSCRIPTION_TIERS.TIER_12_100_YEARLY.priceId,
      upgradePlans: [],
      hidden: true,
    },
    {
      name: 'Ultra',
      price: '$200',
      yearlyPrice: '$2040',
      originalYearlyPrice: '$2400',
      discountPercentage: 15,
      description: 'For power users',
      buttonText: 'Start Free',
      buttonColor: 'bg-secondary text-white',
      isPopular: false,
      hours: '25 hours',
      features: [
        '$200 AI token credits/month',
        '100 custom agents',
        'Private projects',
        'Premium AI Models',
        'Priority support',
      ],
      stripePriceId: config.SUBSCRIPTION_TIERS.TIER_25_200.priceId,
      yearlyStripePriceId: config.SUBSCRIPTION_TIERS.TIER_25_200_YEARLY.priceId,
      monthlyCommitmentStripePriceId: config.SUBSCRIPTION_TIERS.TIER_25_170_YEARLY_COMMITMENT.priceId,
      upgradePlans: [],
    },
    {
      name: 'Enterprise',
      price: '$400',
      yearlyPrice: '$4080',
      originalYearlyPrice: '$4800',
      discountPercentage: 15,
      description: 'For large teams',
      buttonText: 'Start Free',
      buttonColor: 'bg-secondary text-white',
      isPopular: false,
      hours: '50 hours',
      features: [
        '$400 AI token credits/month',
        'Private projects',
        'Premium AI Models',
        'Priority support',
        'Custom integrations',
      ],
      stripePriceId: config.SUBSCRIPTION_TIERS.TIER_50_400.priceId,
      yearlyStripePriceId: config.SUBSCRIPTION_TIERS.TIER_50_400_YEARLY.priceId,
      upgradePlans: [],
      hidden: true,
    },
    {
      name: 'Scale',
      price: '$800',
      yearlyPrice: '$8160',
      originalYearlyPrice: '$9600',
      discountPercentage: 15,
      description: 'For scaling teams',
      buttonText: 'Start Free',
      buttonColor: 'bg-secondary text-white',
      isPopular: false,
      hours: '125 hours',
      features: [
        '$800 AI token credits/month',
        'Private projects',
        'Premium AI Models',
        'Priority support',
        'Custom integrations',
        'Dedicated account manager',
      ],
      stripePriceId: config.SUBSCRIPTION_TIERS.TIER_125_800.priceId,
      yearlyStripePriceId: config.SUBSCRIPTION_TIERS.TIER_125_800_YEARLY.priceId,
      upgradePlans: [],
      hidden: true,
    },
    {
      name: 'Max',
      price: '$1000',
      yearlyPrice: '$10200',
      originalYearlyPrice: '$12000',
      discountPercentage: 15,
      description: 'Maximum performance',
      buttonText: 'Start Free',
      buttonColor: 'bg-secondary text-white',
      isPopular: false,
      hours: '200 hours',
      features: [
        '$1000 AI token credits/month',
        'Private projects',
        'Premium AI Models',
        'Priority support',
        'Custom integrations',
        'Dedicated account manager',
        'Custom deployment',
      ],
      stripePriceId: config.SUBSCRIPTION_TIERS.TIER_200_1000.priceId,
      yearlyStripePriceId: config.SUBSCRIPTION_TIERS.TIER_200_1000_YEARLY.priceId,
      upgradePlans: [],
      hidden: true,
    },
  ],
  companyShowcase: {
    companyLogos: [
      {
        id: 1,
        name: 'MSSC',
        logo: (
          <img
            src="/company-logos/mssc.png"
            alt="MSSC"
            className="h-20 w-auto object-contain"
          />
        ),
      },
      {
        id: 2,
        name: 'Huston',
        logo: (
          <img
            src="/company-logos/huston.png"
            alt="Huston"
            className="h-16 w-auto object-contain"
          />
        ),
      },
      {
        id: 3,
        name: 'PSI',
        logo: (
          <img
            src="/company-logos/psi-cropped.png"
            alt="PSI"
            className="h-18 w-auto object-contain"
          />
        ),
      },
      {
        id: 4,
        name: 'PPS',
        logo: (
          <img
            src="/company-logos/pps.svg"
            alt="PPS"
            className="h-14 w-auto object-contain"
          />
        ),
      },
    ],
  },
  featureSection: {
    title: 'How Omni Works',
    description:
      'Discover how Omni transforms your commands into action in four easy steps',
    items: [
      {
        id: 1,
        title: 'Request an Action',
        content:
          'Speak or type your command—let Omni capture your intent. Your request instantly sets the process in motion.',
        image:
          'https://images.unsplash.com/photo-1720371300677-ba4838fa0678?q=80&w=2070&auto=format&fit=crop&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      },
      {
        id: 2,
        title: 'AI Understanding & Planning',
        content:
          'Omni analyzes your request, understands the context, and develops a structured plan to complete the task efficiently.',
        image:
          'https://images.unsplash.com/photo-1686170287433-c95faf6d3608?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxmZWF0dXJlZC1waG90b3MtZmVlZHwzfHx8ZW58MHx8fHx8fA%3D%3D',
      },
      {
        id: 3,
        title: 'Autonomous Execution',
        content:
          'Using its capabilities and integrations, Omni executes the task independently, handling any complexities along the way.',
        image:
          'https://images.unsplash.com/photo-1720378042271-60aff1e1c538?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxmZWF0dXJlZC1waG90b3MtZmVlZHwxMHx8fGVufDB8fHx8fA%3D%3D',
      },
      {
        id: 4,
        title: 'Results & Learning',
        content:
          'Omni delivers results and learns from each interaction, continuously improving its performance to better serve your needs.',
        image:
          'https://images.unsplash.com/photo-1666882990322-e7f3b8df4f75?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxwaG90by1yZWxhdGVkfDF8fHxlbnwwfHx8fHw%3D',
      },
    ],
  },
  bentoSection: {
    title: 'Empower Your Workflow with Omni',
    description:
      'Let Omni act on your behalf with advanced AI capabilities, seamless integrations, and autonomous task execution.',
    items: [
      {
        id: 1,
        content: <FirstBentoAnimation />,
        title: 'Autonomous Task Execution',
        description:
          'Experience true automation with Omni. Ask your AI Worker to complete tasks, research information, and handle complex workflows with minimal supervision.',
      },
      {
        id: 2,
        content: <SecondBentoAnimation />,
        title: 'Seamless Integrations',
        description:
          'Connect Omni to your existing tools for a unified workflow. Boost productivity through AI-powered interconnected systems.',
      },
      {
        id: 3,
        content: (
          <ThirdBentoAnimation
            data={[20, 30, 25, 45, 40, 55, 75]}
            toolTipValues={[
              1234, 1678, 2101, 2534, 2967, 3400, 3833, 4266, 4700, 5133,
            ]}
          />
        ),
        title: 'Intelligent Data Analysis',
        description:
          "Transform raw data into actionable insights in seconds. Make better decisions with Omni's real-time, adaptive intelligence.",
      },
      {
        id: 4,
        content: <FourthBentoAnimation once={false} />,
        title: 'Complete Customization',
        description:
          'Tailor Omni to your specific needs. As an open source solution, you have full control over its capabilities, integrations, and implementation.',
      },
    ],
  },
  benefits: [
    {
      id: 1,
      text: "Automate everyday tasks with Omni's powerful AI capabilities.",
      image: '/Device-6.png',
    },
    {
      id: 2,
      text: 'Increase productivity with autonomous task completion.',
      image: '/Device-7.png',
    },
    {
      id: 3,
      text: 'Improve focus on high-value work as Omni handles the routine.',
      image: '/Device-8.png',
    },
    {
      id: 4,
      text: 'Access cutting-edge AI as an open source, transparent solution.',
      image: '/Device-1.png',
    },
  ],
  growthSection: {
    title: 'Open Source & Secure',
    description:
      'Where advanced security meets complete transparency—designed to protect your data while providing full access to the code.',
    items: [
      {
        id: 1,
        content: (
          <div
            className="relative flex size-full items-center justify-center overflow-hidden transition-all duration-300 hover:[mask-image:none] hover:[webkit-mask-image:none]"
            style={{
              WebkitMaskImage: `url("data:image/svg+xml,%3Csvg width='265' height='268' viewBox='0 0 265 268' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fillRule='evenodd' clipRule='evenodd' d='M121.384 4.5393C124.406 1.99342 128.319 0.585938 132.374 0.585938C136.429 0.585938 140.342 1.99342 143.365 4.5393C173.074 29.6304 210.174 45.6338 249.754 50.4314C253.64 50.9018 257.221 52.6601 259.855 55.3912C262.489 58.1223 264.005 61.6477 264.13 65.3354C265.616 106.338 254.748 146.9 232.782 182.329C210.816 217.759 178.649 246.61 140.002 265.547C137.645 266.701 135.028 267.301 132.371 267.298C129.715 267.294 127.1 266.686 124.747 265.526C86.0991 246.59 53.9325 217.739 31.9665 182.309C10.0005 146.879 -0.867679 106.317 0.618784 65.3147C0.748654 61.6306 2.26627 58.1102 4.9001 55.3833C7.53394 52.6565 11.1121 50.9012 14.9945 50.4314C54.572 45.6396 91.6716 29.6435 121.384 4.56V4.5393Z' fill='black'/%3E%3C/svg%3E")`,
              maskImage: `url("data:image/svg+xml,%3Csvg width='265' height='268' viewBox='0 0 265 268' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fillRule='evenodd' clipRule='evenodd' d='M121.384 4.5393C124.406 1.99342 128.319 0.585938 132.374 0.585938C136.429 0.585938 140.342 1.99342 143.365 4.5393C173.074 29.6304 210.174 45.6338 249.754 50.4314C253.64 50.9018 257.221 52.6601 259.855 55.3912C262.489 58.1223 264.005 61.6477 264.13 65.3354C265.616 106.338 254.748 146.9 232.782 182.329C210.816 217.759 178.649 246.61 140.002 265.547C137.645 266.701 135.028 267.301 132.371 267.298C129.715 267.294 127.1 266.686 124.747 265.526C86.0991 246.59 53.9325 217.739 31.9665 182.309C10.0005 146.879 -0.867679 106.317 0.618784 65.3147C0.748654 61.6306 2.26627 58.1102 4.9001 55.3833C7.53394 52.6565 11.1121 50.9012 14.9945 50.4314C54.572 45.6396 91.6716 29.6435 121.384 4.56V4.5393Z' fill='black'/%3E%3C/svg%3E")`,
              WebkitMaskSize: 'contain',
              maskSize: 'contain',
              WebkitMaskRepeat: 'no-repeat',
              maskPosition: 'center',
            }}
          >
            <div className="absolute top-[55%] md:top-[58%] left-[55%] md:left-[57%] -translate-x-1/2 -translate-y-1/2  size-full z-10">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="227"
                height="244"
                viewBox="0 0 227 244"
                fill="none"
                className="size-[90%] md:size-[85%] object-contain fill-background"
              >
                <path
                  fillRule="evenodd"
                  clipRule="evenodd"
                  d="M104.06 3.61671C106.656 1.28763 110.017 0 113.5 0C116.983 0 120.344 1.28763 122.94 3.61671C148.459 26.5711 180.325 41.2118 214.322 45.6008C217.66 46.0312 220.736 47.6398 222.999 50.1383C225.262 52.6369 226.563 55.862 226.67 59.2357C227.947 96.7468 218.612 133.854 199.744 166.267C180.877 198.68 153.248 225.074 120.052 242.398C118.028 243.454 115.779 244.003 113.498 244C111.216 243.997 108.969 243.441 106.948 242.379C73.7524 225.055 46.1231 198.661 27.2556 166.248C8.38807 133.835 -0.947042 96.7279 0.329744 59.2168C0.441295 55.8464 1.74484 52.6258 4.00715 50.1311C6.26946 47.6365 9.34293 46.0306 12.6777 45.6008C46.6725 41.2171 78.5389 26.5832 104.06 3.63565V3.61671Z"
                />
              </svg>
            </div>
            <div className="absolute top-[58%] md:top-[60%] left-1/2 -translate-x-1/2 -translate-y-1/2  size-full z-20">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="245"
                height="282"
                viewBox="0 0 245 282"
                className="size-full object-contain fill-accent"
              >
                <g filter="url(#filter0_dddd_2_33)">
                  <path
                    fillRule="evenodd"
                    clipRule="evenodd"
                    d="M113.664 7.33065C116.025 5.21236 119.082 4.04126 122.25 4.04126C125.418 4.04126 128.475 5.21236 130.836 7.33065C154.045 28.2076 183.028 41.5233 213.948 45.5151C216.984 45.9065 219.781 47.3695 221.839 49.6419C223.897 51.9144 225.081 54.8476 225.178 57.916C226.339 92.0322 217.849 125.781 200.689 155.261C183.529 184.74 158.4 208.746 128.209 224.501C126.368 225.462 124.323 225.962 122.248 225.959C120.173 225.956 118.13 225.45 116.291 224.484C86.0997 208.728 60.971 184.723 43.811 155.244C26.6511 125.764 18.1608 92.015 19.322 57.8988C19.4235 54.8334 20.6091 51.9043 22.6666 49.6354C24.7242 47.3665 27.5195 45.906 30.5524 45.5151C61.4706 41.5281 90.4531 28.2186 113.664 7.34787V7.33065Z"
                  />
                </g>
                <defs>
                  <filter
                    id="filter0_dddd_2_33"
                    x="0.217041"
                    y="0.0412598"
                    width="244.066"
                    height="292.917"
                    filterUnits="userSpaceOnUse"
                    colorInterpolationFilters="sRGB"
                  >
                    <feFlood floodOpacity="0" result="BackgroundImageFix" />
                    <feColorMatrix
                      in="SourceAlpha"
                      type="matrix"
                      values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
                      result="hardAlpha"
                    />
                    <feOffset dy="3" />
                    <feGaussianBlur stdDeviation="3.5" />
                    <feColorMatrix
                      type="matrix"
                      values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.04 0"
                    />
                    <feBlend
                      mode="normal"
                      in2="BackgroundImageFix"
                      result="effect1_dropShadow_2_33"
                    />
                    <feColorMatrix
                      in="SourceAlpha"
                      type="matrix"
                      values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
                      result="hardAlpha"
                    />
                    <feOffset dy="12" />
                    <feGaussianBlur stdDeviation="6" />
                    <feColorMatrix
                      type="matrix"
                      values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.04 0"
                    />
                    <feBlend
                      mode="normal"
                      in2="effect1_dropShadow_2_33"
                      result="effect2_dropShadow_2_33"
                    />
                    <feColorMatrix
                      in="SourceAlpha"
                      type="matrix"
                      values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
                      result="hardAlpha"
                    />
                    <feOffset dy="27" />
                    <feGaussianBlur stdDeviation="8" />
                    <feColorMatrix
                      type="matrix"
                      values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.02 0"
                    />
                    <feBlend
                      mode="normal"
                      in2="effect2_dropShadow_2_33"
                      result="effect3_dropShadow_2_33"
                    />
                    <feColorMatrix
                      in="SourceAlpha"
                      type="matrix"
                      values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
                      result="hardAlpha"
                    />
                    <feOffset dy="48" />
                    <feGaussianBlur stdDeviation="9.5" />
                    <feColorMatrix
                      type="matrix"
                      values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.01 0"
                    />
                    <feBlend
                      mode="normal"
                      in2="effect3_dropShadow_2_33"
                      result="effect4_dropShadow_2_33"
                    />
                    <feBlend
                      mode="normal"
                      in="SourceGraphic"
                      in2="effect4_dropShadow_2_33"
                      result="shape"
                    />
                  </filter>
                </defs>
              </svg>
            </div>
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="81"
                height="80"
                viewBox="0 0 81 80"
                className="fill-background"
              >
                <g filter="url(#filter0_iiii_2_34)">
                  <path
                    fillRule="evenodd"
                    clipRule="evenodd"
                    d="M20.5 36V28C20.5 22.6957 22.6071 17.6086 26.3579 13.8579C30.1086 10.1071 35.1957 8 40.5 8C45.8043 8 50.8914 10.1071 54.6421 13.8579C58.3929 17.6086 60.5 22.6957 60.5 28V36C62.6217 36 64.6566 36.8429 66.1569 38.3431C67.6571 39.8434 68.5 41.8783 68.5 44V64C68.5 66.1217 67.6571 68.1566 66.1569 69.6569C64.6566 71.1571 62.6217 72 60.5 72H20.5C18.3783 72 16.3434 71.1571 14.8431 69.6569C13.3429 68.1566 12.5 66.1217 12.5 64V44C12.5 41.8783 13.3429 39.8434 14.8431 38.3431C16.3434 36.8429 18.3783 36 20.5 36ZM52.5 28V36H28.5V28C28.5 24.8174 29.7643 21.7652 32.0147 19.5147C34.2652 17.2643 37.3174 16 40.5 16C43.6826 16 46.7348 17.2643 48.9853 19.5147C51.2357 21.7652 52.5 24.8174 52.5 28Z"
                  />
                </g>
                <defs>
                  <filter
                    id="filter0_iiii_2_34"
                    x="12.5"
                    y="8"
                    width="56"
                    height="70"
                    filterUnits="userSpaceOnUse"
                    colorInterpolationFilters="sRGB"
                  >
                    <feFlood floodOpacity="0" result="BackgroundImageFix" />
                    <feBlend
                      mode="normal"
                      in="SourceGraphic"
                      in2="BackgroundImageFix"
                      result="shape"
                    />
                    <feColorMatrix
                      in="SourceAlpha"
                      type="matrix"
                      values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
                      result="hardAlpha"
                    />
                    <feOffset dy="1" />
                    <feGaussianBlur stdDeviation="1" />
                    <feComposite
                      in2="hardAlpha"
                      operator="arithmetic"
                      k2="-1"
                      k3="1"
                    />
                    <feColorMatrix
                      type="matrix"
                      values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.1 0"
                    />
                    <feBlend
                      mode="normal"
                      in2="shape"
                      result="effect1_innerShadow_2_34"
                    />
                    <feColorMatrix
                      in="SourceAlpha"
                      type="matrix"
                      values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
                      result="hardAlpha"
                    />
                    <feOffset dy="3" />
                    <feGaussianBlur stdDeviation="1.5" />
                    <feComposite
                      in2="hardAlpha"
                      operator="arithmetic"
                      k2="-1"
                      k3="1"
                    />
                    <feColorMatrix
                      type="matrix"
                      values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.09 0"
                    />
                    <feBlend
                      mode="normal"
                      in2="effect1_innerShadow_2_34"
                      result="effect2_innerShadow_2_34"
                    />
                    <feColorMatrix
                      in="SourceAlpha"
                      type="matrix"
                      values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
                      result="hardAlpha"
                    />
                    <feOffset dy="8" />
                    <feGaussianBlur stdDeviation="2.5" />
                    <feComposite
                      in2="hardAlpha"
                      operator="arithmetic"
                      k2="-1"
                      k3="1"
                    />
                    <feColorMatrix
                      type="matrix"
                      values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.05 0"
                    />
                    <feBlend
                      mode="normal"
                      in2="effect2_innerShadow_2_34"
                      result="effect3_innerShadow_2_34"
                    />
                    <feColorMatrix
                      in="SourceAlpha"
                      type="matrix"
                      values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
                      result="hardAlpha"
                    />
                    <feOffset dy="14" />
                    <feGaussianBlur stdDeviation="3" />
                    <feComposite
                      in2="hardAlpha"
                      operator="arithmetic"
                      k2="-1"
                      k3="1"
                    />
                    <feColorMatrix
                      type="matrix"
                      values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.01 0"
                    />
                    <feBlend
                      mode="normal"
                      in2="effect3_innerShadow_2_34"
                      result="effect4_innerShadow_2_34"
                    />
                  </filter>
                </defs>
              </svg>
            </div>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="size-full"
            >
              <FlickeringGrid
                className="size-full"
                gridGap={4}
                squareSize={2}
                maxOpacity={0.5}
              />
            </motion.div>
          </div>
        ),

        title: 'Open Source Security',
        description:
          'Benefit from the security of open source code that thousands of eyes can review, audit, and improve.',
      },
      {
        id: 2,
        content: (
          <div className="relative flex size-full max-w-lg items-center justify-center overflow-hidden [mask-image:linear-gradient(to_top,transparent,black_50%)] -translate-y-20">
            <Globe className="top-28" />
          </div>
        ),

        title: 'Community Powered',
        description:
          "Join a thriving community of developers and users continuously enhancing and expanding Omni's capabilities.",
      },
    ],
  },
  quoteSection: {
    quote:
      'Omni has transformed how we approach everyday tasks. The level of automation it provides, combined with its open source nature, makes it an invaluable tool for our entire organization.',
    author: {
      name: 'Alex Johnson',
      role: 'CTO, Innovatech',
      image: 'https://randomuser.me/api/portraits/men/91.jpg',
    },
  },
  pricing: {
    title: 'Open Source & Free Forever',
    description:
      'Omni is 100% open source and free to use. No hidden fees, no premium features locked behind paywalls.',
    pricingItems: [
      {
        name: 'Community',
        href: '#',
        price: 'Free',
        period: 'forever',
        yearlyPrice: 'Free',
        features: [
          'Full agent capabilities',
          'Unlimited usage',
          'Full source code access',
          'Community support',
        ],
        description: 'Perfect for individual users and developers',
        buttonText: 'Hire Omni',
        buttonColor: 'bg-accent text-primary',
        isPopular: false,
      },
      {
        name: 'Self-Hosted',
        href: '#',
        price: 'Free',
        period: 'forever',
        yearlyPrice: 'Free',
        features: [
          'Full agent capabilities',
          'Unlimited usage',
          'Full source code access',
          'Custom deployment',
          'Local data storage',
          'Integration with your tools',
          'Full customization',
          'Community support',
        ],
        description: 'Ideal for organizations with specific requirements',
        buttonText: 'View Docs',
        buttonColor: 'bg-secondary text-white',
        isPopular: true,
      },
      {
        name: 'Enterprise',
        href: '#',
        price: 'Custom',
        period: '',
        yearlyPrice: 'Custom',
        features: [
          'Everything in Self-Hosted',
          'Priority support',
          'Custom development',
          'Dedicated hosting',
          'SLA guarantees',
        ],
        description: 'For large teams needing custom implementations',
        buttonText: 'Contact Us',
        buttonColor: 'bg-primary text-primary-foreground',
        isPopular: false,
      },
    ],
  },
  testimonials: [
    {
      id: '1',
      name: 'Alex Rivera',
      role: 'CTO at InnovateTech',
      img: 'https://randomuser.me/api/portraits/men/91.jpg',
      description: (
        <p>
          The AI-driven analytics from #QuantumInsights have revolutionized our
          product development cycle.
          <Highlight>
            Insights are now more accurate and faster than ever.
          </Highlight>{' '}
          A game-changer for tech companies.
        </p>
      ),
    },
    {
      id: '2',
      name: 'Samantha Lee',
      role: 'Marketing Director at NextGen Solutions',
      img: 'https://randomuser.me/api/portraits/women/12.jpg',
      description: (
        <p>
          Implementing #AIStream&apos;s customer prediction model has
          drastically improved our targeting strategy.
          <Highlight>Seeing a 50% increase in conversion rates!</Highlight>{' '}
          Highly recommend their solutions.
        </p>
      ),
    },
    {
      id: '3',
      name: 'Raj Patel',
      role: 'Founder & CEO at StartUp Grid',
      img: 'https://randomuser.me/api/portraits/men/45.jpg',
      description: (
        <p>
          As a startup, we need to move fast and stay ahead. #CodeAI&apos;s
          automated coding assistant helps us do just that.
          <Highlight>Our development speed has doubled.</Highlight> Essential
          tool for any startup.
        </p>
      ),
    },
    {
      id: '4',
      name: 'Emily Chen',
      role: 'Product Manager at Digital Wave',
      img: 'https://randomuser.me/api/portraits/women/83.jpg',
      description: (
        <p>
          #VoiceGen&apos;s AI-driven voice synthesis has made creating global
          products a breeze.
          <Highlight>Localization is now seamless and efficient.</Highlight> A
          must-have for global product teams.
        </p>
      ),
    },
    {
      id: '5',
      name: 'Michael Brown',
      role: 'Data Scientist at FinTech Innovations',
      img: 'https://randomuser.me/api/portraits/men/1.jpg',
      description: (
        <p>
          Leveraging #DataCrunch&apos;s AI for our financial models has given us
          an edge in predictive accuracy.
          <Highlight>
            Our investment strategies are now powered by real-time data
            analytics.
          </Highlight>{' '}
          Transformative for the finance industry.
        </p>
      ),
    },
    {
      id: '6',
      name: 'Linda Wu',
      role: 'VP of Operations at LogiChain Solutions',
      img: 'https://randomuser.me/api/portraits/women/5.jpg',
      description: (
        <p>
          #LogiTech&apos;s supply chain optimization tools have drastically
          reduced our operational costs.
          <Highlight>
            Efficiency and accuracy in logistics have never been better.
          </Highlight>{' '}
        </p>
      ),
    },
    {
      id: '7',
      name: 'Carlos Gomez',
      role: 'Head of R&D at EcoInnovate',
      img: 'https://randomuser.me/api/portraits/men/14.jpg',
      description: (
        <p>
          By integrating #GreenTech&apos;s sustainable energy solutions,
          we&apos;ve seen a significant reduction in carbon footprint.
          <Highlight>
            Leading the way in eco-friendly business practices.
          </Highlight>{' '}
          Pioneering change in the industry.
        </p>
      ),
    },
    {
      id: '8',
      name: 'Aisha Khan',
      role: 'Chief Marketing Officer at Fashion Forward',
      img: 'https://randomuser.me/api/portraits/women/56.jpg',
      description: (
        <p>
          #TrendSetter&apos;s market analysis AI has transformed how we approach
          fashion trends.
          <Highlight>
            Our campaigns are now data-driven with higher customer engagement.
          </Highlight>{' '}
          Revolutionizing fashion marketing.
        </p>
      ),
    },
    {
      id: '9',
      name: 'Tom Chen',
      role: 'Director of IT at HealthTech Solutions',
      img: 'https://randomuser.me/api/portraits/men/18.jpg',
      description: (
        <p>
          Implementing #MediCareAI in our patient care systems has improved
          patient outcomes significantly.
          <Highlight>
            Technology and healthcare working hand in hand for better health.
          </Highlight>{' '}
          A milestone in medical technology.
        </p>
      ),
    },
    {
      id: '10',
      name: 'Sofia Patel',
      role: 'CEO at EduTech Innovations',
      img: 'https://randomuser.me/api/portraits/women/73.jpg',
      description: (
        <p>
          #LearnSmart&apos;s AI-driven personalized learning plans have doubled
          student performance metrics.
          <Highlight>
            Education tailored to every learner&apos;s needs.
          </Highlight>{' '}
          Transforming the educational landscape.
        </p>
      ),
    },
    {
      id: '11',
      name: 'Jake Morrison',
      role: 'CTO at SecureNet Tech',
      img: 'https://randomuser.me/api/portraits/men/25.jpg',
      description: (
        <p>
          With #CyberShield&apos;s AI-powered security systems, our data
          protection levels are unmatched.
          <Highlight>
            Ensuring safety and trust in digital spaces.
          </Highlight>{' '}
          Redefining cybersecurity standards.
        </p>
      ),
    },
    {
      id: '12',
      name: 'Nadia Ali',
      role: 'Product Manager at Creative Solutions',
      img: 'https://randomuser.me/api/portraits/women/78.jpg',
      description: (
        <p>
          #DesignPro&apos;s AI has streamlined our creative process, enhancing
          productivity and innovation.
          <Highlight>Bringing creativity and technology together.</Highlight> A
          game-changer for creative industries.
        </p>
      ),
    },
    {
      id: '13',
      name: 'Omar Farooq',
      role: 'Founder at Startup Hub',
      img: 'https://randomuser.me/api/portraits/men/54.jpg',
      description: (
        <p>
          #VentureAI&apos;s insights into startup ecosystems have been
          invaluable for our growth and funding strategies.
          <Highlight>
            Empowering startups with data-driven decisions.
          </Highlight>{' '}
          A catalyst for startup success.
        </p>
      ),
    },
  ],
  faqSection: {
    title: 'Frequently Asked Questions',
    description:
      "Answers to common questions about Omni and its capabilities. If you have any other questions, please don't hesitate to contact us.",
    faQitems: [
      {
        id: 1,
        question: 'What is an AI Worker?',
        answer:
          'An AI Worker is an intelligent software program that can perform tasks autonomously, learn from interactions, and make decisions to help achieve specific goals. It combines artificial intelligence and machine learning to provide personalized assistance and automation.',
      },
      {
        id: 2,
        question: 'How does Omni work?',
        answer:
          'Omni works by analyzing your requirements, leveraging advanced AI algorithms to understand context, and executing tasks based on your instructions. It can integrate with your workflow, learn from feedback, and continuously improve its performance.',
      },
      {
        id: 3,
        question: 'Is Omni really free?',
        answer:
          'Yes, Omni is completely free and open source. We believe in democratizing AI technology and making it accessible to everyone. You can use it, modify it, and contribute to its development without any cost.',
      },
      {
        id: 4,
        question: 'Can I integrate Omni with my existing tools?',
        answer:
          'Yes, Omni is designed to be highly compatible with popular tools and platforms. We offer APIs and pre-built integrations for seamless connection with your existing workflow tools and systems.',
      },
      {
        id: 5,
        question: 'How can I contribute to Omni?',
        answer:
          'You can contribute to Omni by submitting pull requests on GitHub, reporting bugs, suggesting new features, or helping with documentation. Join our community to connect with other contributors and Hire Omni.',
      },
      {
        id: 6,
        question: 'How does Omni save me time?',
        answer:
          'Omni automates repetitive tasks, streamlines workflows, and provides quick solutions to common challenges. This automation and efficiency can save hours of manual work, allowing you to focus on more strategic activities.',
      },
    ],
  },
  ctaSection: {
    id: 'cta',
    title: 'Launch Your First AI Worker Today',
    backgroundImage: '/holo.png',
    button: {
      text: 'Get Started for free',
      href: '/auth',
    },
    subtext: 'Build, manage and train your AI Workforce',
  },
  footerLinks: [
    {
      title: 'Omniscience Labs',
      links: [
        { id: 1, title: 'About', url: 'https://omnisciencelabs.com' },
        { id: 3, title: 'Contact', url: 'mailto:hey@omnisciencelabs.com' },
        { id: 4, title: 'Careers', url: 'https://omnisciencelabs.com/careers' },
      ],
    },
    {
      title: 'Resources',
      links: [
        {
          id: 5,
          title: 'Documentation',
          url: 'https://github.com/omniscience-labs/omni',
        },
        { id: 7, title: 'Discord', url: 'https://discord.gg/Py6pCBUUPw' },
        { id: 8, title: 'GitHub', url: 'https://github.com/omniscience-labs/omni' },
      ],
    },
    {
      title: 'Legal',
      links: [
        {
          id: 9,
          title: 'Privacy Policy',
          url: 'https://omnisciencelabs.com/legal?tab=privacy',
        },
        {
          id: 10,
          title: 'Terms of Service',
          url: 'https://omnisciencelabs.com/legal?tab=terms',
        },
        {
          id: 11,
          title: 'License Apache 2.0',
          url: 'https://github.com/omniscience-labs/omni/blob/main/LICENSE',
        },
      ],
    },
  ],
  useCases: [
    {
      id: 'competitor-analysis',
      title: 'Competitor Analysis',
      description:
        'Analyze the market for my next company in the healthcare industry, located in the UK. Give me the major players, their market size, strengths, and weaknesses, and add their website URLs. Once done, generate a PDF report.',
      category: 'research',
      featured: true,
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M7.75 19.25H16.25C17.3546 19.25 18.25 18.3546 18.25 17.25V8.75L13.75 4.25H7.75C6.64543 4.25 5.75 5.14543 5.75 6.25V17.25C5.75 18.3546 6.64543 19.25 7.75 19.25Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M18 9L14 9C13.4477 9 13 8.55228 13 8L13 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M9.5 14.5L11 13L12.5 14.5L14.5 12.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      image:
        'https://images.unsplash.com/photo-1576091160550-2173dba999ef?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=2400&q=80',
      url: 'https://suna.so/share/2fbf0552-87d6-4d12-be25-d54f435bc493',
    },
    {
      id: 'vc-list',
      title: 'VC List',
      description:
        'Give me the list of the most important VC Funds in the United States based on Assets Under Management. Give me website URLs, and if possible an email to reach them out.',
      category: 'finance',
      featured: true,
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M12 4.75L19.25 9L12 13.25L4.75 9L12 4.75Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M9.25 11.5L4.75 14L12 18.25L19.25 14L14.6722 11.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      image:
        'https://images.unsplash.com/photo-1444653614773-995cb1ef9efa?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=2400&q=80',
      url: 'https://suna.so/share/a172382b-aa77-42a2-a3e1-46f32a0f9c37',
    },
    {
      id: 'candidate-search',
      title: 'Looking for Candidates',
      description:
        "Go on LinkedIn, and find 10 profiles available - they are not working right now - for a junior software engineer position, who are located in Munich, Germany. They should have at least one bachelor's degree in Computer Science or anything related to it, and 1-year of experience in any field/role.",
      category: 'recruitment',
      featured: true,
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M17.25 10C17.25 12.8995 14.8995 15.25 12 15.25C9.10051 15.25 6.75 12.8995 6.75 10C6.75 7.10051 9.10051 4.75 12 4.75C14.8995 4.75 17.25 7.10051 17.25 10Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M8.25 14.75L5.25 19.25"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M15.75 14.75L18.75 19.25"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      image:
        'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=2400&q=80',
      url: 'https://suna.so/share/d9e39c94-4f6f-4b5a-b1a0-b681bfe0dee8',
    },
    {
      id: 'company-trip',
      title: 'Planning Company Trip',
      description:
        "Generate a route plan for my company. We should go to California. We'll be 8 people. Compose the trip from the departure (Paris, France) to the activities we can do considering that the trip will be 7 days long - departure on the 21st of Jun 2025.",
      category: 'travel',
      featured: true,
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M4.75 8.75C4.75 7.64543 5.64543 6.75 6.75 6.75H17.25C18.3546 6.75 19.25 7.64543 19.25 8.75V17.25C19.25 18.3546 18.3546 19.25 17.25 19.25H6.75C5.64543 19.25 4.75 18.3546 4.75 17.25V8.75Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M8 4.75V8.25"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M16 4.75V8.25"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M7.75 10.75H16.25"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      image:
        'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=2400&q=80',
      url: 'https://suna.so/share/23f7d904-eb66-4a9c-9247-b9704ddfd233',
    },
    {
      id: 'excel-spreadsheet',
      title: 'Working on Excel',
      description:
        'My company asked to set up an Excel spreadsheet with all the information about Italian lottery games (Lotto, 10eLotto, and Million Day). Based on that, generate and send me a spreadsheet with all the basic information (public ones).',
      category: 'data',
      featured: true,
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M4.75 6.75C4.75 5.64543 5.64543 4.75 6.75 4.75H17.25C18.3546 4.75 19.25 5.64543 19.25 6.75V17.25C19.25 18.3546 18.3546 19.25 17.25 19.25H6.75C5.64543 19.25 4.75 18.3546 4.75 17.25V6.75Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M9.75 8.75V19"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M5 8.25H19"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      image:
        'https://images.unsplash.com/photo-1532153975070-2e9ab71f1b14?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=2400&q=80',
      url: 'https://suna.so/share/2a147a3a-3778-4624-8285-42474c8c1c9c',
    },
    {
      id: 'speaker-prospecting',
      title: 'Automate Event Speaker Prospecting',
      description:
        "Find 20 AI ethics speakers from Europe who've spoken at conferences in the past year. Scrapes conference sites, cross-references LinkedIn and YouTube, and outputs contact info + talk summaries.",
      category: 'research',
      featured: true,
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M5.75 19.2502H18.25C18.8023 19.2502 19.25 18.8025 19.25 18.2502V5.75C19.25 5.19772 18.8023 4.75 18.25 4.75H5.75C5.19772 4.75 4.75 5.19772 4.75 5.75V18.2502C4.75 18.8025 5.19772 19.2502 5.75 19.2502Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M9.75 8.75C9.75 9.44036 9.19036 10 8.5 10C7.80964 10 7.25 9.44036 7.25 8.75C7.25 8.05964 7.80964 7.5 8.5 7.5C9.19036 7.5 9.75 8.05964 9.75 8.75Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M19.25 13.75L14.75 9.25L7.25 16.75"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      image:
        'https://images.unsplash.com/photo-1523580494863-6f3031224c94?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=2400&q=80',
      url: 'https://suna.so/share/6830cc6d-3fbd-492a-93f8-510a5f48ce50',
    },
    {
      id: 'scientific-papers',
      title: 'Summarize and Cross-Reference Scientific Papers',
      description:
        'Research and compare scientific papers talking about Alcohol effects on our bodies during the last 5 years. Generate a report about the most important scientific papers talking about the topic I wrote before.',
      category: 'research',
      featured: true,
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M4.75 6.75C4.75 5.64543 5.64543 4.75 6.75 4.75H17.25C18.3546 4.75 19.25 5.64543 19.25 6.75V17.25C19.25 18.3546 18.3546 19.25 17.25 19.25H6.75C5.64543 19.25 4.75 18.3546 4.75 17.25V6.75Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M9.75 8.75V19"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M5 8.25H19"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      image:
        'https://images.unsplash.com/photo-1532153975070-2e9ab71f1b14?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=2400&q=80',
      url: 'https://suna.so/share/a106ef9f-ed97-46ee-8e51-7bfaf2ac3c29',
    },
    {
      id: 'lead-generation',
      title: 'Research + First Contact Draft',
      description:
        'Research my potential customers (B2B) on LinkedIn. They should be in the clean tech industry. Find their websites and their email addresses. After that, based on the company profile, generate a personalized first contact email.',
      category: 'sales',
      featured: true,
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M4.75 11.75L10.25 6.25L14.75 10.75L19.25 6.25"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M5.75 19.25H18.25"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M12 11.25V19.25"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      image:
        'https://images.unsplash.com/photo-1552581234-26160f608093?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=2400&q=80',
      url: 'https://suna.so/share/c3472df7-adc1-4d5f-9927-4f8f513ec2fe',
    },
    {
      id: 'seo-analysis',
      title: 'SEO Analysis',
      description:
        "Based on my website suna.so, generate an SEO report analysis, find top-ranking pages by keyword clusters, and identify topics I'm missing.",
      category: 'marketing',
      featured: true,
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M4.75 11.75L10.25 6.25L14.75 10.75L19.25 6.25"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M19.25 6.25V19.25"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M4.75 6.25V19.25"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M4.75 19.25H19.25"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      image:
        'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=2400&q=80',
      url: 'https://suna.so/share/cf756e02-fee9-4281-a0e4-76ac850f1ac9',
    },
    {
      id: 'personal-trip',
      title: 'Generate a Personal Trip',
      description:
        'Generate a personal trip to London, with departure from Bangkok on the 1st of May. The trip will last 10 days. Find an accommodation in the center of London, with a rating on Google reviews of at least 4.5.',
      category: 'travel',
      featured: true,
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M4.75 8.75C4.75 7.64543 5.64543 6.75 6.75 6.75H17.25C18.3546 6.75 19.25 7.64543 19.25 8.75V17.25C19.25 18.3546 18.3546 19.25 17.25 19.25H6.75C5.64543 19.25 4.75 18.3546 4.75 17.25V8.75Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M8 4.75V8.25"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M16 4.75V8.25"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M7.75 10.75H16.25"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      image:
        'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=2400&q=80',
      url: 'https://suna.so/share/8442cc76-ac8b-438c-b539-4b93909a2218',
    },
    {
      id: 'funded-startups',
      title: 'Recently Funded Startups',
      description:
        'Go on Crunchbase, Dealroom, and TechCrunch, filter by Series A funding rounds in the SaaS Finance Space, and build a report with company data, founders, and contact info for outbound sales.',
      category: 'finance',
      featured: true,
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M12 4.75L19.25 9L12 13.25L4.75 9L12 4.75Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M9.25 11.5L4.75 14L12 18.25L19.25 14L14.6722 11.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      image:
        'https://images.unsplash.com/photo-1444653614773-995cb1ef9efa?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=2400&q=80',
      url: 'https://suna.so/share/f04c871c-6bf5-4464-8e9c-5351c9cf5a60',
    },
    {
      id: 'scrape-forums',
      title: 'Scrape Forum Discussions',
      description:
        'I need to find the best beauty centers in Rome, but I want to find them by using open forums that speak about this topic. Go on Google, and scrape the forums by looking for beauty center discussions located in Rome.',
      category: 'research',
      featured: true,
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M5.75 19.2502H18.25C18.8023 19.2502 19.25 18.8025 19.25 18.2502V5.75C19.25 5.19772 18.8023 4.75 18.25 4.75H5.75C5.19772 4.75 4.75 5.19772 4.75 5.75V18.2502C4.75 18.8025 5.19772 19.2502 5.75 19.2502Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M9.75 8.75C9.75 9.44036 9.19036 10 8.5 10C7.80964 10 7.25 9.44036 7.25 8.75C7.25 8.05964 7.80964 7.5 8.5 7.5C9.19036 7.5 9.75 8.05964 9.75 8.75Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M19.25 13.75L14.75 9.25L7.25 16.75"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      image:
        'https://images.unsplash.com/photo-1523580494863-6f3031224c94?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=2400&q=80',
      url: 'https://suna.so/share/53bcd4c7-40d6-4293-9f69-e2638ddcfad8',
    },
  ],
};

export type SiteConfig = typeof siteConfig;
