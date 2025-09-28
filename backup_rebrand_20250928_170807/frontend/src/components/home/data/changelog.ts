import { ChangelogData } from "../sections/changelog";

export const changeLogData: ChangelogData[] = [
    {
      version: "Version 1.1.0",
      date: "11th August 2025",
      title: "Introducing Custom Agents, Agent Marketplace, and much more!",
      description:
        "The most significant update for Suna yet. Build, customize, and share AI Workers. Connect any service, automate complex workflows, and discover a thriving marketplace of community-built agents.",
      items: [
        "Custom Agent Builder - Create specialized AI Workers with tailored system prompts and behaviors",
        "Model Context Protocol (MCP) Integration - Connect agents to any external service",
        "Agent Marketplace - Discover, install, and share agents with the community",
        "Unified Integrations Hub - Manage all your service connections in one place",
        "Version Control for Agents - Track changes, create versions, and rollback safely",
        "Enterprise-Grade Security - Encrypted credential management and secure agent execution"
      ],
      image: "/thumbnail-dark.png",
      button: {
        url: "/agents",
        text: "Explore Agents",
      },
    },
  ];