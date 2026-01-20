'use client';

import { useState, useEffect, Suspense, useCallback } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

function LegalContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Get tab from URL or default to "imprint"
  const tabParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<'terms' | 'privacy' | 'imprint'>(
    tabParam === 'terms' || tabParam === 'privacy' || tabParam === 'imprint' ? tabParam : 'imprint',
  );

  // Sync active tab with URL parameter when it changes
  useEffect(() => {
    const validTab = tabParam === 'terms' || tabParam === 'privacy' || tabParam === 'imprint' ? tabParam : 'imprint';
    if (validTab !== activeTab) {
      setActiveTab(validTab);
    }
  }, [tabParam]);

  // Handle tab change - updates both state and URL
  const handleTabChange = (tab: 'terms' | 'privacy' | 'imprint') => {
    setActiveTab(tab);
    const params = new URLSearchParams(searchParams);
    params.set('tab', tab);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <main className="flex flex-col items-center justify-center min-h-screen w-full bg-background">
      <section className="w-full pb-20">
        <div className="flex flex-col items-center w-full px-6 pt-10">
          <div className="max-w-4xl w-full mx-auto">
            <div className="flex items-center justify-center mb-10">
              <h1 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-primary">
                Legal Information
              </h1>
            </div>

            <div className="flex justify-center mb-8">
              <div className="flex space-x-4 border-b border-border">
                <button
                  onClick={() => handleTabChange('imprint')}
                  className={`pb-2 px-4 ${activeTab === 'imprint'
                      ? 'border-b-2 border-primary font-medium text-primary'
                      : 'text-muted-foreground hover:text-primary/80 transition-colors'
                    }`}
                >
                  Imprint
                </button>
                <button
                  onClick={() => handleTabChange('terms')}
                  className={`pb-2 px-4 ${activeTab === 'terms'
                      ? 'border-b-2 border-primary font-medium text-primary'
                      : 'text-muted-foreground hover:text-primary/80 transition-colors'
                    }`}
                >
                  Terms of Service
                </button>
                <button
                  onClick={() => handleTabChange('privacy')}
                  className={`pb-2 px-4 ${activeTab === 'privacy'
                      ? 'border-b-2 border-primary font-medium text-primary'
                      : 'text-muted-foreground hover:text-primary/80 transition-colors'
                    }`}
                >
                  Privacy Policy
                </button>
              </div>
            </div>

            <Card>
              <CardContent className="p-8">
                <div className="prose prose-sm max-w-none dark:prose-invert">
                  {activeTab === 'imprint' ? (
                    <div>
                      <h2 className="text-2xl font-medium tracking-tight mb-4">
                        Imprint
                      </h2>
                      <p className="text-sm text-muted-foreground mb-6">
                        Information according to legal requirements
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Company Information
                      </h3>
                      <div className="text-muted-foreground mb-6 space-y-2">
                        <p>
                          <strong>Kortix AI Corp</strong>
                        </p>
                        <p>Incorporated in Delaware, United States</p>
                        <p className="mt-4">
                          <strong>Principal Place of Business:</strong>
                        </p>
                        <p>701 Tillery Street</p>
                        <p>Unit 12-2521</p>
                        <p>Austin, TX 78702</p>
                        <p>United States</p>
                        <p className="mt-4">
                          <strong>Registered Agent:</strong>
                        </p>
                        <p>Firstbase Agent LLC</p>
                        <p>1007 N Orange St. 4th Floor Suite #1382</p>
                        <p>Wilmington, DE 19801</p>
                        <p>United States</p>
                      </div>

                      <h3 className="text-lg font-medium tracking-tight">
                        Contact
                      </h3>
                      <div className="text-muted-foreground mb-6">
                        <p>
                          Email:{' '}
                          <a
                            href="mailto:info@kortix.com"
                            className="text-primary hover:underline"
                          >
                            info@kortix.com
                          </a>
                        </p>
                      </div>

                      <h3 className="text-lg font-medium tracking-tight">
                        Responsible for Content
                      </h3>
                      <p className="text-muted-foreground mb-6">
                        Kortix AI Corp is responsible for the content of this
                        website in accordance with applicable laws.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Disclaimer
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">
                        The information provided on this website is for general
                        informational purposes only. While we strive to keep the
                        information up to date and accurate, we make no
                        representations or warranties of any kind, express or
                        implied, about the completeness, accuracy, reliability,
                        suitability, or availability of the information contained
                        on the website.
                      </p>
                    </div>
                  ) : activeTab === 'terms' ? (
                    <div>
                      <h2 className="text-2xl font-medium tracking-tight mb-4">
                        Terms of Service
                      </h2>
                      <p className="text-sm text-muted-foreground mb-6">
                        Last updated: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Terms of Service & Privacy Policy
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        Last updated and effective date: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
                      </p>

                      <p className="text-muted-foreground text-balance mb-6">
                        PLEASE READ THESE TERMS OF USE ("AGREEMENT" OR "TERMS OF
                        USE" or "TERMS OF SERVICE" or "TERMS AND CONDITIONS")
                        CAREFULLY BEFORE USING THE SERVICES OFFERED BY Kortix AI
                        Corp, a Delaware corporation with its principal place of business
                        at 701 Tillery Street Unit 12-2521, Austin, Texas 78702, United States
                        ("Company"). THIS AGREEMENT SETS FORTH THE LEGALLY
                        BINDING TERMS AND CONDITIONS FOR YOUR USE OF THE Kortix
                        WEBSITE AND ALL RELATED SERVICES.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Definitions
                      </h3>
                      <ul className="text-muted-foreground space-y-1 mb-6">
                        <li>
                          "Company" refers to Kortix AI Corp, a Delaware corporation
                          with its principal place of business at 701 Tillery Street
                          Unit 12-2521, Austin, Texas 78702, United States.
                        </li>
                        <li>
                          "Site" refers to the Kortix website, including any related
                          features, content, or applications offered from time to
                          time by the Company.
                        </li>
                        <li>
                          "Service" refers to the Kortix platform and all related
                          services provided by the Company, including the platform
                          for building, managing, and training autonomous AI agents,
                          browser automation, file management, web intelligence,
                          system operations, API integrations, and agent builder tools.
                        </li>
                        <li>
                          "Agent" refers to an autonomous AI worker created, configured,
                          or deployed through the Service that can perform tasks
                          independently based on user instructions.
                        </li>
                        <li>
                          "Agent Actions" refers to any autonomous operations performed
                          by Agents, including but not limited to browser automation,
                          file operations, web crawling, API calls, system commands,
                          and interactions with third-party services.
                        </li>
                        <li>
                          "User" refers to any individual or entity using the Site
                          or Service.
                        </li>
                        <li>
                          "Account" refers to a user account with associated resources,
                          including agents, threads, files, and configurations.
                        </li>
                        <li>
                          "Team Member" refers to an invited user on a shared Account
                          with appropriate access permissions.
                        </li>
                        <li>
                          "API" refers to programmatic access to the Service via REST
                          endpoints or the Python SDK.
                        </li>
                        <li>
                          "API Key" refers to authentication credentials issued by
                          the Company for programmatic access to the Service.
                        </li>
                        <li>
                          "Content" refers to any text, images, code, or other
                          material uploaded to or generated by the Site or Service
                          by Users or Agents.
                        </li>
                        <li>
                          "Assets" refers to the results and outputs generated by
                          Agents or the Service, including any code, applications,
                          documents, reports, presentations, or other deliverables.
                        </li>
                        <li>
                          "Third-Party Services" refers to external services integrated
                          with the Service, including but not limited to Composio,
                          Apify, MCP servers, LLM providers (Anthropic, OpenAI, etc.),
                          Supabase, and other third-party APIs and services.
                        </li>
                        <li>
                          "Self-Hosting" refers to deployment of the Service on
                          user's own infrastructure, subject to the terms of the
                          LICENSE file.
                        </li>
                        <li>
                          "Terms of Use" refers to these terms and conditions
                          governing the use of the Site and Service.
                        </li>
                        <li>
                          "License" refers to the permissions granted to Users to
                          use the Site and Service as outlined in these Terms of
                          Use, or the separate LICENSE file for self-hosting.
                        </li>
                        <li>
                          "DMCA" refers to the Digital Millennium Copyright Act.
                        </li>
                        <li>
                          "Fees" refers to the subscription or other payments made
                          by Users for access to certain features or levels of the
                          Service, including usage-based charges and third-party
                          service costs passed through.
                        </li>
                        <li>
                          "Notice Address" refers to the contact address for the
                          Company, specifically legal@kortix.com
                        </li>
                        <li>
                          "Privacy Policy" refers to the document outlining how
                          the Company collects, uses, and protects User data.
                        </li>
                        <li>
                          "Third Party" refers to any person or entity other than
                          the Company or the User.
                        </li>
                        <li>
                          "AAA Rules" refers to the American Arbitration
                          Association's Consumer Arbitration Rules.
                        </li>
                        <li>
                          "Claim" refers to any dispute, claim, demand, or cause
                          of action that arises between the User and the Company.
                        </li>
                      </ul>

                      <h3 className="text-lg font-medium tracking-tight">
                        Acceptance of Terms of Use
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        The Service is offered subject to acceptance without
                        modification of all of these Terms of Use and all other
                        operating rules, policies, and procedures that may be
                        published from time to time in connection with the
                        Services by the Company. In addition, some services
                        offered through the Service may be subject to additional
                        terms and conditions promulgated by the Company from time
                        to time; your use of such services is subject to those
                        additional terms and conditions, which are incorporated
                        into these Terms of Use by this reference.
                      </p>

                      <p className="text-muted-foreground text-balance mb-6">
                        The Company may, in its sole discretion, refuse to offer
                        the Service to any person or entity and change its
                        eligibility criteria at any time. This provision is void
                        where prohibited by law and the right to access the
                        Service is revoked in such jurisdictions.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Description of Service
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        Kortix is a complete platform for creating, managing, and
                        training autonomous AI agents. The Service enables Users to
                        build sophisticated AI agents that can work autonomously
                        on their behalf. The platform provides:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          <strong>Agent Builder:</strong> Tools to create, configure,
                          and customize AI agents with specific capabilities and
                          personalities
                        </li>
                        <li>
                          <strong>Browser Automation:</strong> Agents can navigate
                          websites, extract data, fill forms, and automate web workflows
                        </li>
                        <li>
                          <strong>File Management:</strong> Agents can create, edit,
                          and organize documents, spreadsheets, presentations, and code
                        </li>
                        <li>
                          <strong>Web Intelligence:</strong> Web crawling, search
                          capabilities, data extraction, and information synthesis
                        </li>
                        <li>
                          <strong>System Operations:</strong> Command-line execution,
                          system administration, and DevOps task automation
                        </li>
                        <li>
                          <strong>API Integrations:</strong> Connection with 2700+
                          third-party services via Composio, Apify, MCP servers, and
                          direct API integrations
                        </li>
                        <li>
                          <strong>Multi-Tenant Architecture:</strong> Account management,
                          team collaboration, shared resources, and API key access
                        </li>
                        <li>
                          <strong>Self-Hosting Options:</strong> Deployment on your own
                          infrastructure (subject to LICENSE file restrictions)
                        </li>
                        <li>
                          <strong>API and SDK Access:</strong> Programmatic access via
                          REST endpoints and Python SDK
                        </li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-6">
                        Agents operate autonomously based on your instructions and can
                        perform complex, multi-step tasks independently. You acknowledge
                        that Agents may interact with third-party services, access
                        external data sources, and perform actions that have real-world
                        consequences.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Rules and Conduct
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        By using the Service, you agree that it is intended for the
                        purpose of creating and deploying autonomous AI agents to help
                        accomplish real-world tasks. You acknowledge and agree that when
                        using the Service, you must have the necessary rights and
                        permissions for any content, data, or actions you direct Agents
                        to perform. You are solely responsible for ensuring that your
                        use of the Service is legal and that you have the necessary
                        rights for any tasks you perform or direct Agents to perform.
                        The Company is not responsible for any content created or actions
                        taken through the Service and disclaims all liability for any
                        issues arising from the created content or performed actions,
                        including but not limited to copyright infringement, illegal
                        content, unauthorized access, or any other legal matters.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Content Moderation & Prohibited Uses
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>User Responsibility for Agent Outputs.</strong> You are
                        responsible for reviewing all Agent outputs and ensuring they
                        comply with applicable laws and these Terms of Use. The Company
                        reserves the right, but not the obligation, to monitor, review,
                        and remove any Agent-generated content or disable any Agent
                        actions that violate these Terms of Use.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Prohibited Uses.</strong> As a condition of use, you
                        promise not to use the Service or direct Agents to perform any
                        action that is prohibited by the Terms of Use. By way of
                        example, and not as a limitation, you shall not (and shall not
                        permit any third party or Agent to) take any action that:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          would constitute a violation of any applicable law, rule, or
                          regulation;
                        </li>
                        <li>
                          infringes upon any intellectual property or other right of any
                          other person or entity;
                        </li>
                        <li>
                          is threatening, abusive, harassing, defamatory, libelous,
                          deceptive, fraudulent, invasive of another's privacy, tortious,
                          obscene, offensive, furthering of self-harm, or profane;
                        </li>
                        <li>
                          creates Assets or Agent outputs that exploit or abuse children;
                        </li>
                        <li>
                          generates or disseminates verifiably false information with the
                          purpose of harming others;
                        </li>
                        <li>
                          impersonates or attempts to impersonate others;
                        </li>
                        <li>
                          generates or disseminates personally identifying or identifiable
                          information without authorization;
                        </li>
                        <li>
                          creates Assets that imply or promote support of a terrorist
                          organization;
                        </li>
                        <li>
                          creates Assets that condone or promote violence against people
                          based on any protected legal category;
                        </li>
                        <li>
                          uses Agents to circumvent security measures, authentication
                          systems, or terms of service of third-party services;
                        </li>
                        <li>
                          uses Agents for automated scraping at scale without explicit
                          permission from the target website or service;
                        </li>
                        <li>
                          uses Agents for competitive intelligence gathering through
                          unauthorized access or violation of third-party terms;
                        </li>
                        <li>
                          uses Agents to reverse engineer, decompile, or disassemble
                          third-party services or software;
                        </li>
                        <li>
                          uses Agents for security testing, penetration testing, or
                          vulnerability scanning without explicit authorization;
                        </li>
                        <li>
                          uses Agents to interfere with, disrupt, or damage any system,
                          network, or service;
                        </li>
                        <li>
                          uses Agents to send unsolicited communications, spam, or
                          phishing attempts;
                        </li>
                        <li>
                          uses Agents to access, modify, or delete data without proper
                          authorization;
                        </li>
                        <li>
                          uses Agents in a manner that violates export control laws or
                          sanctions;
                        </li>
                        <li>
                          uses Agents to create or distribute malware, viruses, or other
                          harmful code.
                        </li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Third-Party Service Compliance.</strong> When using
                        Agents to interact with third-party services, you are responsible
                        for ensuring compliance with those services' terms of service,
                        acceptable use policies, and rate limits. The Company is not
                        responsible for violations of third-party terms by your Agents.
                      </p>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>Content Removal.</strong> The Company reserves the right
                        to remove any content, disable any Agent, or suspend or terminate
                        your Account if it determines, in its sole discretion, that you
                        have violated these Terms of Use or engaged in prohibited uses.
                        The Company may take such action without prior notice, though it
                        will attempt to provide notice when reasonably possible.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        User Responsibility for Created Content
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">
                        You agree not to create any content or perform any actions
                        that are illegal, infringe on the rights of any third
                        party, or violate any applicable law, regulation, or these
                        Terms of Use. The Company reserves the right to remove any
                        content or disable any action that it deems to be in
                        violation of these Terms of Use, at its sole discretion,
                        and without notice. You are solely responsible for any
                        content you create or actions you perform, and you agree
                        to indemnify and hold harmless the Company from any
                        claims, losses, damages, or expenses arising out of or
                        related to your created content or performed actions.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Agent Autonomy & Liability
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Autonomous Operation.</strong> Agents created through
                        the Service operate autonomously based on your instructions.
                        Once configured and deployed, Agents may perform actions
                        independently without requiring your immediate supervision or
                        approval for each action.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>User Responsibility.</strong> You are solely responsible
                        for all Agent Actions and outputs, including but not limited to:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          All actions performed by Agents on your behalf or at your
                          direction
                        </li>
                        <li>
                          All content, data, or outputs generated by Agents
                        </li>
                        <li>
                          Agent interactions with third-party services, websites, or
                          APIs
                        </li>
                        <li>
                          Agent access to, modification of, or deletion of files,
                          data, or systems
                        </li>
                        <li>
                          Compliance with all applicable laws, regulations, and
                          third-party terms of service
                        </li>
                        <li>
                          Ensuring you have necessary rights, permissions, and
                          authorizations for all Agent operations
                        </li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Company Disclaimers.</strong> The Company disclaims all
                        liability for:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          Agent errors, malfunctions, bugs, or unintended actions
                        </li>
                        <li>
                          Data loss, corruption, or unauthorized access resulting from
                          Agent operations
                        </li>
                        <li>
                          Unauthorized Agent actions, including actions beyond the
                          scope of your instructions
                        </li>
                        <li>
                          Third-party service failures, outages, or changes that
                          affect Agent functionality
                        </li>
                        <li>
                          Agent-generated content that violates laws, regulations, or
                          third-party rights
                        </li>
                        <li>
                          Security breaches or vulnerabilities in Agent configurations
                          or third-party integrations
                        </li>
                        <li>
                          Financial losses, business interruptions, or other
                          consequences of Agent actions
                        </li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Monitoring and Review.</strong> You acknowledge that
                        Agents operate autonomously and that you should regularly
                        monitor Agent activities and review Agent outputs. The Company
                        is not responsible for monitoring your Agents or alerting you
                        to potentially problematic Agent actions.
                      </p>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>Indemnification.</strong> You agree to indemnify, defend,
                        and hold harmless the Company, its affiliates, and their
                        respective officers, directors, employees, and agents from and
                        against any and all claims, damages, obligations, losses,
                        liabilities, costs, or debt, and expenses (including but not
                        limited to attorney's fees) arising from: (i) your use of and
                        access to the Service; (ii) your violation of any term of
                        these Terms of Use; (iii) your violation of any third-party
                        right, including without limitation any copyright, property, or
                        privacy right; (iv) any Agent Actions or Agent-generated content;
                        or (v) any claim that Agent Actions or Agent-generated content
                        caused damage to a third party.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Software License
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">
                        For the full license terms, please refer to the LICENSE file in our GitHub repository:{' '}
                        <a
                          href="https://github.com/kortix-ai/suna/blob/main/LICENSE"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          github.com/kortix-ai/suna/blob/main/LICENSE
                        </a>
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Accuracy Disclaimer
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">
                        The Service is provided for general assistance purposes.
                        The analysis and results generated by the AI are not
                        guaranteed to be error-free and should be thoroughly
                        verified before relying on them. Users assume full
                        responsibility for any content created or actions
                        performed using the Service.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        DMCA and Takedowns Policy
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">
                        The Company utilizes artificial intelligence systems to
                        generate content and perform actions. Such generation may
                        unintentionally involve copyrighted material or trademarks
                        held by others. We respect rights holders internationally,
                        and we ask our users to do the same. If you believe your
                        copyright or trademark is being infringed by the Service,
                        please write to legal@kortix.com and we will process and
                        investigate your request and take appropriate actions
                        under the Digital Millennium Copyright Act and other
                        applicable intellectual property laws with respect to any
                        alleged or actual infringement.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Data Retention, Deletion, and User Rights
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Data Retention.</strong> The Company retains your data
                        for as long as necessary to provide the Service and comply with
                        legal obligations. Upon account termination, the Company will
                        delete or anonymize your personal data in accordance with our
                        data retention policies, except where retention is required by
                        law or for legitimate business purposes (such as fraud prevention
                        or dispute resolution). Backup and archival data may be retained
                        for a limited period after account deletion.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Your Rights.</strong> You have the right to:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          <strong>Access:</strong> Request access to your personal data
                          and information about how it is processed
                        </li>
                        <li>
                          <strong>Export:</strong> Request export of your data in a
                          machine-readable format
                        </li>
                        <li>
                          <strong>Correction:</strong> Request correction of inaccurate
                          or incomplete data
                        </li>
                        <li>
                          <strong>Deletion:</strong> Request deletion of your account and
                          associated data
                        </li>
                        <li>
                          <strong>Portability:</strong> Request transfer of your data to
                          another service provider
                        </li>
                        <li>
                          <strong>Objection:</strong> Object to certain types of data
                          processing
                        </li>
                        <li>
                          <strong>Restriction:</strong> Request restriction of data
                          processing in certain circumstances
                        </li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        To exercise these rights, please contact us at{' '}
                        <a
                          href="mailto:info@kortix.com"
                          className="text-primary hover:underline"
                        >
                          info@kortix.com
                        </a>
                        . We will respond to your request within a reasonable timeframe
                        and in accordance with applicable law.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>GDPR Rights (EU Users).</strong> If you are located in
                        the European Union, you have additional rights under the General
                        Data Protection Regulation (GDPR), including:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          Right to be informed about data processing
                        </li>
                        <li>
                          Right of access to your personal data
                        </li>
                        <li>
                          Right to rectification of inaccurate data
                        </li>
                        <li>
                          Right to erasure ("right to be forgotten")
                        </li>
                        <li>
                          Right to restrict processing
                        </li>
                        <li>
                          Right to data portability
                        </li>
                        <li>
                          Right to object to processing
                        </li>
                        <li>
                          Rights related to automated decision-making and profiling
                        </li>
                        <li>
                          Right to lodge a complaint with a supervisory authority
                        </li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        For GDPR-related requests, please contact us at{' '}
                        <a
                          href="mailto:info@kortix.com"
                          className="text-primary hover:underline"
                        >
                          info@kortix.com
                        </a>
                        . Our legal basis for processing your data includes performance
                        of contract, legitimate interests, consent, and compliance with
                        legal obligations. We implement appropriate safeguards for
                        international data transfers.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>CCPA Rights (California Users).</strong> If you are a
                        California resident, you have rights under the California
                        Consumer Privacy Act (CCPA), including:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          <strong>Right to Know:</strong> Request disclosure of
                          categories and specific pieces of personal information
                          collected, used, disclosed, or sold
                        </li>
                        <li>
                          <strong>Right to Delete:</strong> Request deletion of personal
                          information collected from you
                        </li>
                        <li>
                          <strong>Right to Opt-Out:</strong> Opt-out of the sale of
                          personal information (if applicable)
                        </li>
                        <li>
                          <strong>Right to Non-Discrimination:</strong> Exercise your
                          rights without discrimination
                        </li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        Categories of personal information we collect include:
                        identifiers (name, email, IP address), commercial information
                        (purchase history, subscription data), internet activity
                        (usage data, interactions with Service), geolocation data, and
                        inferences drawn from the above.
                      </p>
                      <p className="text-muted-foreground text-balance mb-6">
                        To exercise your CCPA rights, please contact us at{' '}
                        <a
                          href="mailto:info@kortix.com"
                          className="text-primary hover:underline"
                        >
                          info@kortix.com
                        </a>
                        . We may require verification of your identity before processing
                        your request. We will not discriminate against you for exercising
                        your CCPA rights.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Fees and Payments
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        The Company may offer paid Services. You can learn more
                        about our pricing after signing up. You may sign up for a
                        subscription, payable in U.S. dollars, that will
                        automatically renew. You can stop using the Service and
                        cancel your subscription at any time through the website
                        or by emailing us at info@kortix.com. If you cancel
                        your subscription, you may not receive a refund or credit
                        for any amounts that have already been billed or paid. The
                        Company reserves the right to change its prices at any
                        time. If you are on a subscription plan, changes to
                        pricing will not apply until your next renewal.
                      </p>

                      <p className="text-muted-foreground text-balance mb-4">
                        Unless otherwise stated, your subscription fees ("Fees")
                        do not include federal, state, local, and foreign taxes,
                        duties, and other similar assessments ("Taxes"). You are
                        responsible for all Taxes associated with your purchase
                        and we may invoice you for such Taxes. You agree to timely
                        pay such Taxes and provide us with documentation showing
                        the payment or additional evidence that we may reasonably
                        require. If any amount of your Fees is past due, we may
                        suspend your access to the Services after we provide you
                        with written notice of late payment.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Usage-Based Billing.</strong> Some features of the
                        Service may be subject to usage-based billing, including but not
                        limited to API calls, Agent execution time, data storage, and
                        third-party service costs (such as LLM provider fees, Apify
                        costs, etc.). These costs may be passed through to you with
                        applicable markups. You will be notified of usage-based charges
                        in advance or as they are incurred.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Credit System.</strong> The Service may utilize a credit
                        system where 1 credit equals $0.01 USD. Credits may be consumed
                        for various Service features and third-party service usage.
                        Credits are non-refundable and may expire according to the terms
                        of your subscription plan.
                      </p>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>Payment Methods.</strong> Payments must be made in U.S.
                        dollars using accepted payment methods. The Company reserves the
                        right to change accepted payment methods at any time. All
                        payments are processed securely through third-party payment
                        processors.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Service Availability & Modifications
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Service Availability.</strong> The Service is provided
                        "as is" and "as available" without any guarantee of uptime,
                        availability, or performance. The Company does not provide any
                        Service Level Agreement (SLA) unless explicitly stated in a
                        separate written agreement. The Service may be unavailable due to
                        maintenance, updates, technical issues, or circumstances beyond
                        the Company's control.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Planned Maintenance.</strong> The Company may perform
                        planned maintenance that may temporarily interrupt Service
                        availability. The Company will attempt to provide advance notice
                        of planned maintenance when reasonably possible, but is not
                        obligated to do so.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Service Modifications.</strong> The Company reserves the
                        right to modify, update, or discontinue any feature, function, or
                        aspect of the Service at any time, with or without notice. This
                        includes but is not limited to changes to APIs, Agent
                        capabilities, third-party integrations, user interfaces, and
                        pricing.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Feature Deprecation.</strong> The Company may deprecate
                        features, APIs, or functionality with reasonable notice. The
                        Company will attempt to provide advance notice of deprecations
                        and migration paths when available, but is not obligated to
                        maintain backward compatibility indefinitely.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Service Suspension.</strong> The Company reserves the
                        right to suspend or terminate your access to the Service
                        immediately, without notice, if you violate these Terms of Use,
                        engage in fraudulent or illegal activity, or if required by law
                        or court order.
                      </p>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>No Guarantees.</strong> The Company does not guarantee
                        that the Service will be uninterrupted, error-free, secure, or
                        free from viruses or other harmful components. You acknowledge
                        that use of the Service involves inherent risks and that the
                        Company is not responsible for any losses or damages resulting
                        from Service unavailability, errors, or interruptions.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        API Usage & Rate Limits
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>API Access.</strong> The Service provides programmatic
                        access via REST endpoints and a Python SDK. API access requires
                        an API Key, which you can create and manage through your Account.
                        You are responsible for maintaining the security and
                        confidentiality of your API Keys.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>API Key Security.</strong> You must not share, publish,
                        or expose your API Keys. You are responsible for all activities
                        that occur using your API Keys, whether authorized by you or not.
                        If you believe an API Key has been compromised, you must
                        immediately revoke it and create a new one. The Company is not
                        responsible for any unauthorized access or use of your API Keys.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Rate Limits & Fair Use.</strong> The Service is subject
                        to rate limits and fair use policies to ensure equitable access
                        and system stability. Rate limits may vary based on your
                        subscription plan and may be adjusted by the Company at any time.
                        You agree not to:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          Exceed rate limits or attempt to circumvent rate limiting
                          mechanisms
                        </li>
                        <li>
                          Use automated tools or scripts to make excessive API calls
                        </li>
                        <li>
                          Engage in any activity that places undue burden on the Service
                          infrastructure
                        </li>
                        <li>
                          Use the API in a manner that interferes with other users'
                          access to the Service
                        </li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Usage Quotas.</strong> Your subscription plan may include
                        usage quotas for API calls, Agent executions, data storage, or
                        other Service features. Quotas reset according to your billing
                        cycle. Exceeding quotas may result in temporary suspension of
                        API access or additional charges.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Abuse & Enforcement.</strong> The Company monitors API
                        usage for abuse, fraud, and violations of these Terms of Use. If
                        the Company determines, in its sole discretion, that you are
                        abusing the API or violating these Terms, the Company may:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          Temporarily or permanently suspend your API access
                        </li>
                        <li>
                          Revoke your API Keys
                        </li>
                        <li>
                          Terminate your Account
                        </li>
                        <li>
                          Take legal action if necessary
                        </li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>API Changes.</strong> The Company reserves the right to
                        modify, deprecate, or discontinue API endpoints, SDK
                        functionality, or authentication methods at any time. The Company
                        will attempt to provide reasonable notice of breaking changes,
                        but is not obligated to maintain backward compatibility
                        indefinitely.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Termination
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Termination by Company.</strong> The Company may terminate
                        your access to all or any part of the Service at any time if you
                        fail to comply with these Terms of Use, which may result in the
                        forfeiture and destruction of all information associated with
                        your account. The Company may also terminate the Service for any
                        reason with reasonable notice.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Termination by User.</strong> You may terminate your
                        Account at any time by following the instructions on the Service
                        or by contacting us at{' '}
                        <a
                          href="mailto:info@kortix.com"
                          className="text-primary hover:underline"
                        >
                          info@kortix.com
                        </a>
                        . Termination of your Account will result in the deletion of
                        your data in accordance with our data retention policies.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Data Deletion.</strong> Upon termination, the Company
                        will delete or anonymize your personal data and Account
                        information in accordance with applicable law and our data
                        retention policies. You are responsible for exporting any data
                        you wish to retain before terminating your Account. The Company
                        may retain certain data for legal, regulatory, or business
                        purposes as permitted by law.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Outstanding Obligations.</strong> Any fees paid
                        hereunder are non-refundable. Upon termination, you remain
                        responsible for all outstanding fees, charges, and obligations
                        incurred prior to termination.
                      </p>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>Survival.</strong> Upon any termination, all rights and
                        licenses granted to you in this Agreement shall immediately
                        terminate, but all provisions hereof which by their nature
                        should survive termination shall survive termination, including,
                        without limitation, warranty disclaimers, indemnity, limitations
                        of liability, intellectual property provisions, and dispute
                        resolution provisions.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Dispute Resolution by Binding Arbitration
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        PLEASE READ THIS SECTION CAREFULLY, AS IT AFFECTS YOUR
                        RIGHTS.
                      </p>

                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Agreement to Arbitrate.</strong> You and the
                        Company agree that any and all disputes, claims, demands,
                        or causes of action ("Claims") that have arisen or may
                        arise between you and us, whether arising out of or
                        relating to these Terms, the Site, or any aspect of the
                        relationship or transactions between us, will be resolved
                        exclusively through final and binding arbitration before a
                        neutral arbitrator, rather than in a court by a judge or
                        jury, in accordance with the terms of this Arbitration
                        Agreement, except that you or we may (but are not required
                        to) assert individual Claims in small claims court if such
                        Claims are within the scope of such court's jurisdiction.
                      </p>

                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>
                          Prohibition of Class and Representative Actions.
                        </strong>{' '}
                        YOU AND WE AGREE THAT EACH OF US MAY BRING CLAIMS AGAINST
                        THE OTHER ONLY ON AN INDIVIDUAL BASIS AND NOT AS A
                        PLAINTIFF OR CLASS MEMBER IN ANY PURPORTED CLASS OR
                        REPRESENTATIVE ACTION OR PROCEEDING.
                      </p>

                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Pre-Arbitration Dispute Resolution.</strong>{' '}
                        Before commencing any arbitration, you agree to provide
                        the Company with a written notice of Claim, and the
                        Company agrees to provide you with a written notice of
                        Claim to the extent reasonably possible based on the
                        availability of your contact information to the Company.
                        The Notice must describe the nature and basis of the Claim
                        in sufficient detail and set forth the specific relief
                        sought.
                      </p>

                      <p className="text-muted-foreground text-balance mb-6">
                        Both parties agree that they will attempt to resolve a
                        Claim through informal negotiation within sixty (60)
                        calendar days from the date the Notice is received. If the
                        Claim is not resolved within sixty (60) calendar days
                        after the Notice is received, you or we may commence an
                        arbitration proceeding.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Choice of Law
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">
                        Any and all Claims shall be governed by the Federal
                        Arbitration Act and the internal substantive laws of the
                        State of Delaware, United States, in all respects, without
                        regard for the jurisdiction or forum in which the user is
                        domiciled, resides, or is located at the time of such access
                        or use. Except as provided in the Arbitration Agreement, all
                        Claims will be brought in the federal or state courts located
                        in Delaware, and you and the Company each unconditionally,
                        voluntarily, and irrevocably consent to the exclusive personal
                        jurisdiction and venue of those courts.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Third-Party Services & Integrations
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Third-Party Integrations.</strong> The Service integrates
                        with numerous third-party services, including but not limited to:
                        Composio (for 2700+ app integrations), Apify (for web scraping),
                        MCP servers (for external tool integrations), LLM providers
                        (Anthropic, OpenAI, and others via LiteLLM), Supabase (for
                        database and authentication), and various other APIs and services.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Your Responsibility.</strong> When using Agents to
                        interact with third-party services, you are solely responsible
                        for:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          Compliance with all third-party terms of service, acceptable
                          use policies, and API terms
                        </li>
                        <li>
                          Obtaining necessary authorizations, licenses, and permissions
                          to access third-party services
                        </li>
                        <li>
                          Ensuring your use of third-party services through Agents is
                          lawful and authorized
                        </li>
                        <li>
                          Any fees, charges, or costs imposed by third-party services
                        </li>
                        <li>
                          Data privacy and security when sharing data with third-party
                          services
                        </li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Company Disclaimers.</strong> The Company is not
                        responsible for:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          Third-party service availability, outages, or changes
                        </li>
                        <li>
                          Third-party service failures that affect Agent functionality
                        </li>
                        <li>
                          Third-party service modifications, deprecations, or
                          discontinuations
                        </li>
                        <li>
                          Data handling, privacy practices, or security of third-party
                          services
                        </li>
                        <li>
                          Violations of third-party terms by your Agents or use of the
                          Service
                        </li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Data Sharing.</strong> When you use Agents to interact
                        with third-party services, data may be shared with those
                        services in accordance with their privacy policies and terms of
                        service. The Company's Privacy Policy describes how we handle
                        data, but third-party services are governed by their own privacy
                        policies.
                      </p>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>Third-Party Service Changes.</strong> Third-party
                        services may change their APIs, terms, or discontinue services
                        at any time. The Company is not responsible for maintaining
                        compatibility with third-party service changes and may need to
                        update or remove integrations accordingly. The Company will
                        attempt to provide reasonable notice of significant integration
                        changes when possible.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Export Control Compliance
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Compliance with Export Laws.</strong> The Service,
                        including software, technology, and technical data, may be
                        subject to U.S. export control laws, including the Export
                        Administration Regulations (EAR) and International Traffic in
                        Arms Regulations (ITAR). You agree to comply with all applicable
                        export control laws and regulations.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Prohibited Countries & Users.</strong> You represent and
                        warrant that you are not located in, under the control of, or a
                        national or resident of any country subject to U.S. trade
                        embargoes or sanctions, including but not limited to Cuba, Iran,
                        North Korea, Syria, and the Crimea region of Ukraine. You also
                        represent that you are not on any U.S. government list of
                        prohibited or restricted parties.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Restricted Uses.</strong> You agree not to use the
                        Service in any manner that would violate U.S. export control
                        laws, including but not limited to:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          Exporting, re-exporting, or transferring the Service to
                          prohibited countries or restricted parties
                        </li>
                        <li>
                          Using the Service for purposes prohibited by export control
                          laws
                        </li>
                        <li>
                          Facilitating transactions or activities that violate export
                          control laws
                        </li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>Company Rights.</strong> The Company reserves the right
                        to restrict access to the Service from any country or to any
                        user based on export control requirements, sanctions, or other
                        legal obligations. The Company may suspend or terminate your
                        Account if it determines, in its sole discretion, that your use
                        of the Service violates export control laws or poses a risk of
                        such violation.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Self-Hosting
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">
                        The Service software is available for self-hosting on your own
                        infrastructure, subject to the terms of the LICENSE file in our
                        GitHub repository. Self-hosting is governed by the Kortix Public
                        Source License (KPSL), which includes restrictions on
                        network-accessible deployments and commercial use. For
                        network-accessible deployments or commercial use beyond the
                        LICENSE terms, a separate commercial license agreement is
                        required. Please refer to the LICENSE file for complete terms
                        and contact{' '}
                        <a
                          href="mailto:hey@kortix.com"
                          className="text-primary hover:underline"
                        >
                          hey@kortix.com
                        </a>
                        {' '}for commercial licensing inquiries.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Links to and From Other Websites
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">
                        You may gain access to other websites via links on the
                        Site. These Terms apply to the Site only and do not apply
                        to other parties' websites. Similarly, you may have come
                        to the Site via a link from another website. The terms of
                        use of other websites do not apply to the Site. The
                        Company assumes no responsibility for any terms of use or
                        material outside of the Site accessed via any link.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Modification of Terms of Use
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">
                        At its sole discretion, the Company may modify or replace
                        any of the Terms of Use, or change, suspend, or
                        discontinue the Service (including without limitation, the
                        availability of any feature, database, or content) at any
                        time by posting a notice on the Site or by sending you an
                        email. The Company may also impose limits on certain
                        features and services or restrict your access to parts or
                        all of the Service without notice or liability. It is your
                        responsibility to check the Terms of Use periodically for
                        changes. Your continued use of the Service following the
                        posting of any changes to the Terms of Use constitutes
                        acceptance of those changes.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Trademarks and Patents
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">
                        All Kortix logos, marks, and designations are trademarks or
                        registered trademarks of the Company. All other trademarks
                        mentioned on this website are the property of their
                        respective owners. The trademarks and logos displayed on
                        this website may not be used without the prior written
                        consent of the Company or their respective owners.
                        Portions, features, and/or functionality of the Company's
                        products may be protected under the Company's patent
                        applications or patents.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Intellectual Property & Ownership
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Service License.</strong> Subject to your compliance
                        with this Agreement, the conditions herein, and any limitations
                        applicable to the Company or by law, you are granted a
                        non-exclusive, limited, non-transferable, non-sublicensable,
                        non-assignable, freely revocable license to access and use the
                        Service for business or personal use.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>User Ownership of Assets.</strong> You own all Assets
                        you create with the Services, including but not limited to:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          Generated content, code, documents, reports, presentations,
                          and other deliverables created by Agents
                        </li>
                        <li>
                          Agent configurations, prompts, and customizations created by
                          you
                        </li>
                        <li>
                          Derivative works based on Agent outputs
                        </li>
                        <li>
                          Data, files, and content you upload or provide to the Service
                        </li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        The Company hereby assigns to you all rights, title, and interest
                        in and to such Assets for your personal or commercial use,
                        subject to the limitations below.
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Company Retained Rights.</strong> The Company retains all
                        rights in and to:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          The Service platform, software, infrastructure, and technology
                        </li>
                        <li>
                          Pre-existing training data, models, and algorithms used by
                          underlying AI systems (including but not limited to LLM
                          providers such as Anthropic, OpenAI, and others)
                        </li>
                        <li>
                          Agent templates, examples, and pre-configured agents provided
                          by the Company
                        </li>
                        <li>
                          Improvements, modifications, and enhancements to the platform
                          itself
                        </li>
                        <li>
                          Company trademarks, logos, and branding
                        </li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>License to Company.</strong> You grant the Company a
                        worldwide, non-exclusive, royalty-free license to use, store,
                        process, and analyze your Assets and Agent configurations for
                        the purposes of:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          Providing, maintaining, and improving the Service
                        </li>
                        <li>
                          Analytics, monitoring, and service optimization
                        </li>
                        <li>
                          Compliance with legal obligations and enforcement of these
                          Terms of Use
                        </li>
                        <li>
                          Security, fraud prevention, and abuse detection
                        </li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Third-Party Content.</strong> If your Assets incorporate
                        third-party content, materials, or intellectual property, you
                        are solely responsible for obtaining all necessary rights,
                        licenses, and permissions. The Company does not grant you any
                        rights to third-party content.
                      </p>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>Account Responsibility.</strong> Each person must have a
                        unique account, and you are responsible for any activity
                        conducted on your account, including by Team Members or through
                        API Keys you create. A breach or violation of any of our Terms of
                        Use may result in an immediate termination of your right to use
                        our Service.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Indemnification
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">
                        You shall defend, indemnify, and hold harmless the
                        Company, its affiliates, and each of its, and its
                        affiliates employees, contractors, directors, suppliers,
                        and representatives from all liabilities, losses, claims,
                        and expenses, including reasonable attorneys' fees, that
                        arise from or relate to (i) your use or misuse of, or
                        access to, the Service, or (ii) your violation of the
                        Terms of Use or any applicable law, contract, policy,
                        regulation, or other obligation. The Company reserves the
                        right to assume the exclusive defense and control of any
                        matter otherwise subject to indemnification by you, in
                        which event you will assist and cooperate with the Company
                        in connection therewith.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Limitation of Liability
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">
                        IN NO EVENT SHALL THE COMPANY OR ITS DIRECTORS, EMPLOYEES,
                        AGENTS, PARTNERS, SUPPLIERS, OR CONTENT PROVIDERS, BE
                        LIABLE UNDER CONTRACT, TORT, STRICT LIABILITY, NEGLIGENCE,
                        OR ANY OTHER LEGAL OR EQUITABLE THEORY WITH RESPECT TO THE
                        SERVICE (I) FOR ANY LOST PROFITS, DATA LOSS, COST OF
                        PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES, OR SPECIAL,
                        INDIRECT, INCIDENTAL, PUNITIVE, OR CONSEQUENTIAL DAMAGES
                        OF ANY KIND WHATSOVER, OR SUBSTITUTE GOODS OR SERVICES,
                        (II) FOR YOUR RELIANCE ON THE SERVICE, INCLUDING ANY
                        APPLICATIONS CREATED USING THE AI, OR (III) FOR ANY DIRECT
                        DAMAGES IN EXCESS (IN THE AGGREGATE) OF THE FEES PAID BY
                        YOU FOR THE SERVICE OR, IF GREATER, $100. SOME STATES DO
                        NOT ALLOW THE EXCLUSION OR LIMITATION OF INCIDENTAL OR
                        CONSEQUENTIAL DAMAGES, SO THE ABOVE LIMITATIONS AND
                        EXCLUSIONS MAY NOT APPLY TO YOU.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Disclaimer
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">
                        ALL USE OF THE SERVICE AND ANY CONTENT IS UNDERTAKEN
                        ENTIRELY AT YOUR OWN RISK. THE SERVICE (INCLUDING, WITHOUT
                        LIMITATION, THE Kortix WEB APP AND ANY CONTENT) IS PROVIDED
                        "AS IS" AND "AS AVAILABLE" AND IS WITHOUT WARRANTY OF ANY
                        KIND, EXPRESS OR IMPLIED, INCLUDING, BUT NOT LIMITED TO,
                        THE IMPLIED WARRANTIES OF TITLE, NON-INFRINGEMENT,
                        MERCHANTABILITY, AND FITNESS FOR A PARTICULAR PURPOSE, AND
                        ANY WARRANTIES IMPLIED BY ANY COURSE OF PERFORMANCE OR
                        USAGE OF TRADE, ALL OF WHICH ARE EXPRESSLY DISCLAIMED.
                        Kortix DOES NOT GUARANTEE THE ACCURACY, COMPLETENESS, OR
                        RELIABILITY OF THE AI-GENERATED CONTENT, AND USERS ASSUME
                        FULL RESPONSIBILITY FOR ANY APPLICATIONS CREATED USING THE
                        SERVICE. SOME STATES DO NOT ALLOW LIMITATIONS ON HOW LONG
                        AN IMPLIED WARRANTY LASTS, SO THE ABOVE LIMITATIONS MAY
                        NOT APPLY TO YOU.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Age Requirements
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        By accessing the Services, you confirm that you're at
                        least 18 years old and meet the minimum age of digital
                        consent in your country. If you are not old enough to
                        consent to our Terms of Use in your country, your parent
                        or guardian must agree to this Agreement on your behalf.
                      </p>

                      <p className="text-muted-foreground text-balance mb-6">
                        Please ask your parent or guardian to read these terms
                        with you. If you're a parent or legal guardian, and you
                        allow your teenager to use the Services, then these terms
                        also apply to you and you're responsible for your
                        teenager's activity on the Services. No assurances are
                        made as to the suitability of the Assets for you.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Contact Us
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        For questions regarding the Service, you can get in touch by
                        emailing us at{' '}
                        <a
                          href="mailto:info@kortix.com"
                          className="text-primary hover:underline"
                        >
                          info@kortix.com
                        </a>
                        .
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Legal Matters:</strong> For legal inquiries, DMCA
                        notices, or other legal matters, please contact{' '}
                        <a
                          href="mailto:legal@kortix.com"
                          className="text-primary hover:underline"
                        >
                          legal@kortix.com
                        </a>
                        .
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>Data Privacy Requests:</strong> For GDPR, CCPA, or other
                        data privacy requests (access, deletion, portability, etc.),
                        please contact{' '}
                        <a
                          href="mailto:info@kortix.com"
                          className="text-primary hover:underline"
                        >
                          info@kortix.com
                        </a>
                        {' '}with the subject line "Privacy Request" and include details
                        of your request.
                      </p>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>Mailing Address:</strong> Kortix AI Corp, 701 Tillery
                        Street Unit 12-2521, Austin, Texas 78702, United States.
                      </p>
                    </div>
                  ) : (
                    <div>
                      <h2 className="text-2xl font-medium tracking-tight mb-4">
                        Privacy Policy
                      </h2>
                      <p className="text-sm text-muted-foreground mb-6">
                        Last updated: {new Date().toLocaleDateString()}
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Privacy
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">
                        Our commitment to privacy and data protection is reflected
                        in this Privacy Statement which describes how we collect
                        and process "personal information" that identifies you,
                        like your name or email address. Any other information
                        besides this is "non-personal information." If we store
                        personal information with non-personal information, we'll
                        consider that combination to be personal information.
                      </p>

                      <p className="text-muted-foreground text-balance mb-6">
                        References to our "Services" at Kortix in this statement
                        include our website, apps, and other products and
                        services. This statement applies to our Services that
                        display or reference this Privacy Statement. Third-party
                        services that we integrate with are governed under their
                        own privacy policies.
                      </p>

                      <p className="text-muted-foreground text-balance mb-6">
                        Kortix does not collect biometric or identifying
                        information. All data is processed securely and any data
                        is deleted upon account removal.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Information Gathering
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        We learn information about you when:
                      </p>

                      <p className="font-medium mb-2">
                        You directly provide it to us.
                      </p>
                      <p className="text-muted-foreground mb-2">
                        For example, we collect:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          Name and contact information. We collect details such as
                          name and email address.
                        </li>
                        <li>
                          Payment information. If you make a purchase, we collect
                          credit card numbers, financial account information, and
                          other payment details.
                        </li>
                        <li>
                          Content and files. We collect and retain the videos,
                          documents, or other files you send to us in connection
                          with delivering our Services, including via email or
                          chat.
                        </li>
                      </ul>

                      <p className="font-medium mb-2">
                        We collect it automatically through our products and
                        services.
                      </p>
                      <p className="text-muted-foreground mb-2">
                        For instance, we collect:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          Identifiers and device information. When you visit our
                          websites, our web servers log your Internet Protocol
                          (IP) address and information about your device,
                          including device identifiers, device type, operating
                          system, browser, and other software including type,
                          version, language, settings, and configuration.
                        </li>
                        <li>
                          Geolocation data. Depending on your device and app
                          settings, we collect geolocation data when you use our
                          Services.
                        </li>
                        <li>
                          Usage data. We log your activity on our website,
                          including the URL of the website from which you came to
                          our site, pages you viewed on our website, how long you
                          spent on a page, access times, and other details about
                          your use of and actions on our website. We also collect
                          information about which web-elements or objects you
                          interact with on our Service, metadata about your
                          activity on the Service, changes in your user state, and
                          the duration of your use of our Service.
                        </li>
                      </ul>

                      <p className="font-medium mb-2">
                        Someone else tells us information about you.
                      </p>
                      <p className="text-muted-foreground mb-2">
                        Third-party sources include, for example:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          Third-party partners. Third-party applications and
                          services, including social networks you choose to
                          connect with or interact with through our services.
                        </li>
                        <li>
                          Service providers. Third parties that collect or provide
                          data in connection with work they do on our behalf, for
                          example, companies that determine your device's location
                          based on its IP address.
                        </li>
                      </ul>

                      <p className="font-medium mb-2">
                        When we try and understand more about you based on
                        information you've given to us.
                      </p>
                      <p className="text-muted-foreground text-balance mb-6">
                        We infer new information from other data we collect,
                        including using automated means to generate information
                        about your likely preferences or other characteristics
                        ("inferences"). For example, we infer your general
                        geographic location based on your IP address.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Information Use
                      </h3>
                      <p className="text-muted-foreground text-balance mb-2">
                        We use each category of personal information about you:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-6">
                        <li>To provide you with our Services</li>
                        <li>To improve and develop our Services</li>
                        <li>To communicate with you</li>
                        <li>To provide customer support</li>
                      </ul>

                      <h3 className="text-lg font-medium tracking-tight">
                        Information Sharing
                      </h3>
                      <p className="text-muted-foreground text-balance mb-2">
                        We share information about you:
                      </p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          When we've asked & received your consent to share it.
                        </li>
                        <li>
                          As needed, including to third-party service providers,
                          to process or provide Services or products to you, but
                          only if those entities agree to provide at least the
                          same level of privacy protection we're committed to
                          under this Privacy Statement.
                        </li>
                        <li>
                          To comply with laws or to respond to lawful requests and
                          legal processes, provided that we'll notify you unless
                          we're legally prohibited from doing so. We'll only
                          release personal information if we believe in good faith
                          that it's legally required.
                        </li>
                        <li>
                          Only if we reasonably believe it's necessary to prevent
                          harm to the rights, property, or safety of you or
                          others.
                        </li>
                        <li>
                          In the event of a corporate restructuring or change in
                          our organizational structure or status to a successor or
                          affiliate.
                        </li>
                      </ul>

                      <p className="text-muted-foreground text-balance mb-4">
                        Please note that some of our Services include
                        integrations, references, or links to services provided by
                        third parties whose privacy practices differ from ours. If
                        you provide personal information to any of those third
                        parties, or allow us to share personal information with
                        them, that data is governed by their privacy statements.
                      </p>

                      <p className="text-muted-foreground text-balance mb-6">
                        Finally, we may share non-personal information in
                        accordance with applicable law.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Information Protection
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">
                        We implement physical, business, and technical security
                        measures to safeguard your personal information. In the
                        event of a security breach, we'll notify you so that you
                        can take appropriate protective steps. We only keep your
                        personal information for as long as is needed to do what
                        we collected it for. After that, we destroy it unless
                        required by law.
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Contact Us
                      </h3>
                      <p className="text-muted-foreground text-balance">
                        You can get in touch by emailing us at{' '}
                        <a
                          href="mailto:info@kortix.com"
                          className="text-primary hover:underline"
                        >
                          info@kortix.com
                        </a>
                        .
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>
    </main>
  );
}

// Wrap the LegalContent component with Suspense to handle useSearchParams()
export default function LegalPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen">
          Loading...
        </div>
      }
    >
      <LegalContent />
    </Suspense>
  );
}
