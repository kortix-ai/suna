import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Agent Conversation | Kortix Suna",
  description: "Interactive agent conversation powered by Kortix Suna",
  openGraph: {
    title: "Agent Conversation | Kortix Suna",
    description: "Interactive agent conversation powered by Kortix Suna",
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