import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Agent Conversation | Kortix Kortix",
  description: "Interactive agent conversation powered by Kortix Kortix",
  openGraph: {
    title: "Agent Conversation | Kortix Kortix",
    description: "Interactive agent conversation powered by Kortix Kortix",
    type: "website",
  },
};

export default function AgentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
} 