'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { FlickeringGrid } from '@/components/home/ui/flickering-grid';
import { useMediaQuery } from '@/hooks/use-media-query';
import { ArrowLeft } from 'lucide-react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';

function LegalContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Get tab from URL or default to "terms"
  const tabParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<'terms' | 'privacy'>(
    tabParam === 'terms' || tabParam === 'privacy' ? tabParam : 'terms',
  );

  const tablet = useMediaQuery('(max-width: 1024px)');
  const [mounted, setMounted] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);

  // Function to update URL without refreshing the page
  const updateUrl = (tab: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', tab);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  useEffect(() => {
    setMounted(true);

    // Update the URL if it doesn't match the active tab
    if (tabParam !== activeTab) {
      updateUrl(activeTab);
    }
  }, [tabParam, activeTab, updateUrl]);

  // Update the URL when the tab changes
  useEffect(() => {
    updateUrl(activeTab);
  }, [activeTab, updateUrl]);

  // Update the active tab when URL changes
  useEffect(() => {
    if (tabParam === 'terms' || tabParam === 'privacy') {
      setActiveTab(tabParam);
    }
  }, [tabParam]);

  // Handle tab change
  const handleTabChange = (tab: 'terms' | 'privacy') => {
    setActiveTab(tab);
  };

  return (
    <main className="flex flex-col items-center justify-center min-h-screen w-full">
      <section className="w-full relative overflow-hidden pb-20">
        <div className="relative flex flex-col items-center w-full px-6 pt-10">
          {/* Left side flickering grid with gradient fades - similar to hero section */}
          <div className="absolute left-0 top-0 h-[600px] w-1/3 -z-10 overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-background z-10" />
            <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-background via-background/90 to-transparent z-10" />
            <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-background via-background/90 to-transparent z-10" />

            <FlickeringGrid
              className="h-full w-full"
              squareSize={mounted && tablet ? 2 : 2.5}
              gridGap={mounted && tablet ? 2 : 2.5}
              color="var(--secondary)"
              maxOpacity={0.4}
              flickerChance={isScrolling ? 0.01 : 0.03}
            />
          </div>

          {/* Right side flickering grid with gradient fades */}
          <div className="absolute right-0 top-0 h-[600px] w-1/3 -z-10 overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-l from-transparent via-transparent to-background z-10" />
            <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-background via-background/90 to-transparent z-10" />
            <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-background via-background/90 to-transparent z-10" />

            <FlickeringGrid
              className="h-full w-full"
              squareSize={mounted && tablet ? 2 : 2.5}
              gridGap={mounted && tablet ? 2 : 2.5}
              color="var(--secondary)"
              maxOpacity={0.4}
              flickerChance={isScrolling ? 0.01 : 0.03}
            />
          </div>

          {/* Center content background with rounded bottom */}
          <div className="absolute inset-x-1/4 top-0 h-[600px] -z-20 bg-background rounded-b-xl"></div>

          <div className="max-w-4xl w-full mx-auto">
            <div className="flex items-center justify-center mb-10 relative">
              <Link
                href="/"
                className="absolute left-0 group border border-border/50 bg-background hover:bg-accent/20 hover:border-secondary/40 rounded-full text-sm h-8 px-3 flex items-center gap-2 transition-all duration-300 shadow-sm hover:shadow-md hover:scale-105"
              >
                <ArrowLeft size={14} className="text-muted-foreground" />
                <span className="font-medium text-muted-foreground text-xs tracking-wide">
                  Back
                </span>
              </Link>

              <h1 className="text-3xl md:text-4xl font-medium tracking-tighter text-center">
                Legal <span className="text-secondary">Information</span>
              </h1>
            </div>

            <div className="flex justify-center mb-8">
              <div className="flex space-x-4 border-b border-border">
                <button
                  onClick={() => handleTabChange('terms')}
                  className={`pb-2 px-4 ${
                    activeTab === 'terms'
                      ? 'border-b-2 border-secondary font-medium text-secondary'
                      : 'text-muted-foreground hover:text-primary/80 transition-colors'
                  }`}
                >
                  Terms of Service
                </button>
                <button
                  onClick={() => handleTabChange('privacy')}
                  className={`pb-2 px-4 ${
                    activeTab === 'privacy'
                      ? 'border-b-2 border-secondary font-medium text-secondary'
                      : 'text-muted-foreground hover:text-primary/80 transition-colors'
                  }`}
                >
                  Privacy Policy
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-[#F3F4F6] dark:bg-[#F9FAFB]/[0.02] p-8 shadow-sm">
              <div className="prose prose-sm max-w-none dark:prose-invert">
                {activeTab === 'terms' ? (
                  <div>
                    <h2 className="text-2xl font-medium tracking-tight mb-4">
                      Terms of Service
                    </h2>
                    <p className="text-sm text-muted-foreground mb-6">
                      Last updated: {new Date().toLocaleDateString()}
                    </p>

                    <h3 className="text-lg font-medium tracking-tight">
                      Terms of Service & Privacy Policy
                    </h3>
                    <p className="text-muted-foreground text-balance mb-4">
                      Last updated and effective date: 13 August 2024
                    </p>

                    <p className="text-muted-foreground text-balance mb-6">
                      PLEASE READ THESE TERMS OF USE ("AGREEMENT" OR "TERMS OF
                      USE" or "TERMS OF SERVICE" or "TERMS AND CONDITIONS")
                      CAREFULLY BEFORE USING THE SERVICES OFFERED BY Kortix AI
                      Corp (701 Tillery Street Unit 12-2521 Austin, Texas 78702,
                      United States). THIS AGREEMENT SETS FORTH THE LEGALLY
                      BINDING TERMS AND CONDITIONS FOR YOUR USE OF THE SUNA
                      WEBSITE AND ALL RELATED SERVICES.
                    </p>

                    <h3 className="text-lg font-medium tracking-tight">
                      Definitions
                    </h3>
                    <ul className="text-muted-foreground space-y-1 mb-6">
                      <li>
                        "Company" refers to Kortix AI Corp (701 Tillery Street
                        Unit 12-2521 Austin, Texas 78702, United States).
                      </li>
                      <li>
                        "Site" refers to the Suna website, including any related
                        features, content, or applications offered from time to
                        time by the Company.
                      </li>
                      <li>
                        "Service" refers to the Suna website and all related
                        services provided by the Company, including the
                        AI-powered agent that helps you accomplish real-world
                        tasks.
                      </li>
                      <li>
                        "User" refers to any individual or entity using the Site
                        or Service.
                      </li>
                      <li>
                        "Content" refers to any text, images, code, or other
                        material uploaded to or generated by the Site or Service
                        by Users.
                      </li>
                      <li>
                        "Assets" refers to the results and outputs generated by
                        the AI models provided by the Service, including any
                        code, applications, or reports.
                      </li>
                      <li>
                        "Terms of Use" refers to these terms and conditions
                        governing the use of the Site and Service.
                      </li>
                      <li>
                        "License" refers to the permissions granted to Users to
                        use the Site and Service as outlined in these Terms of
                        Use.
                      </li>
                      <li>
                        "DMCA" refers to the Digital Millennium Copyright Act.
                      </li>
                      <li>
                        "Fees" refers to the subscription or other payments made
                        by Users for access to certain features or levels of the
                        Service.
                      </li>
                      <li>
                        "Notice Address" refers to the contact address for the
                        Company, specifically legal@kortix.ai
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
                      Rules and Conduct
                    </h3>
                    <p className="text-muted-foreground text-balance mb-4">
                      By using the Service, you agree that it is intended solely
                      for the purpose of using an AI assistant to help
                      accomplish real-world tasks through natural conversation.
                      The Service's capabilities include browser automation,
                      file management, web crawling, search capabilities,
                      command-line execution, website deployment, and
                      integration with various APIs and services. You
                      acknowledge and agree that when using the Service, you
                      must have the necessary rights and permissions for any
                      content or data you incorporate. You are solely
                      responsible for ensuring that your use of the Service is
                      legal and that you have the necessary rights for any tasks
                      you perform. The Company is not responsible for any
                      content created or actions taken through the Service and
                      disclaims all liability for any issues arising from the
                      created content or performed actions, including but not
                      limited to copyright infringement, illegal content, or any
                      other legal matters.
                    </p>

                    <p className="text-muted-foreground text-balance mb-4">
                      As a condition of use, you promise not to use the Service
                      for any purpose that is prohibited by the Terms of Use. By
                      way of example, and not as a limitation, you shall not
                      (and shall not permit any third party to) take any action
                      (including making use of the Site, any Assets, or our
                      models or derivatives of our models) that:
                    </p>

                    <ul className="text-muted-foreground space-y-1 mb-6">
                      <li>
                        would constitute a violation of any applicable law,
                        rule, or regulation;
                      </li>
                      <li>
                        infringes upon any intellectual property or other right
                        of any other person or entity;
                      </li>
                      <li>
                        is threatening, abusive, harassing, defamatory,
                        libelous, deceptive, fraudulent, invasive of another's
                        privacy, tortious, obscene, offensive, furthering of
                        self-harm, or profane;
                      </li>
                      <li>creates Assets that exploit or abuse children;</li>
                      <li>
                        generates or disseminates verifiably false information
                        with the purpose of harming others;
                      </li>
                      <li>impersonates or attempts to impersonate others;</li>
                      <li>
                        generates or disseminates personally identifying or
                        identifiable information;
                      </li>
                      <li>
                        creates Assets that imply or promote support of a
                        terrorist organization;
                      </li>
                      <li>
                        creates Assets that condone or promote violence against
                        people based on any protected legal category.
                      </li>
                    </ul>

                    <p className="text-muted-foreground text-balance mb-6">
                      You agree not to use the Service for the purpose of
                      generating illegal or harmful applications or content.
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
                      Open Source License
                    </h3>
                    <p className="text-muted-foreground text-balance mb-6">
                      Suna is licensed under the Apache License, Version 2.0.
                      You may obtain a copy of the License at{' '}
                      <a
                        href="http://www.apache.org/licenses/LICENSE-2.0"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-secondary hover:underline"
                      >
                        http://www.apache.org/licenses/LICENSE-2.0
                      </a>
                      . Unless required by applicable law or agreed to in
                      writing, software distributed under the License is
                      distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
                      CONDITIONS OF ANY KIND, either express or implied. See the
                      License for the specific language governing permissions
                      and limitations under the License.
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
                      please write to legal@kortixai.com and we will process and
                      investigate your request and take appropriate actions
                      under the Digital Millennium Copyright Act and other
                      applicable intellectual property laws with respect to any
                      alleged or actual infringement.
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
                      or by emailing us at legal@kortixai.com. If you cancel
                      your subscription, you may not receive a refund or credit
                      for any amounts that have already been billed or paid. The
                      Company reserves the right to change its prices at any
                      time. If you are on a subscription plan, changes to
                      pricing will not apply until your next renewal.
                    </p>

                    <p className="text-muted-foreground text-balance mb-6">
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

                    <h3 className="text-lg font-medium tracking-tight">
                      Termination
                    </h3>
                    <p className="text-muted-foreground text-balance mb-6">
                      The Company may terminate your access to all or any part
                      of the Service at any time if you fail to comply with
                      these Terms of Use, which may result in the forfeiture and
                      destruction of all information associated with your
                      account. Further, either party may terminate the Services
                      for any reason and at any time upon written notice. If you
                      wish to terminate your account, you may do so by following
                      the instructions on the Service. Any fees paid hereunder
                      are non-refundable. Upon any termination, all rights and
                      licenses granted to you in this Agreement shall
                      immediately terminate, but all provisions hereof which by
                      their nature should survive termination shall survive
                      termination, including, without limitation, warranty
                      disclaimers, indemnity, and limitations of liability.
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
                      Arbitration Act and the internal substantive laws of
                      Singapore in all respects, without regard for the
                      jurisdiction or forum in which the user is domiciled,
                      resides, or is located at the time of such access or use.
                      Except as provided in the Arbitration Agreement, all
                      Claims will be brought in the federal or state courts in
                      Singapore, and you and the Company each unconditionally,
                      voluntarily, and irrevocably consent to the exclusive
                      personal jurisdiction and venue of those courts.
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
                      All Suna logos, marks, and designations are trademarks or
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
                      Licensing Terms
                    </h3>
                    <p className="text-muted-foreground text-balance mb-4">
                      Subject to your compliance with this Agreement, the
                      conditions herein, and any limitations applicable to the
                      Company or by law:
                    </p>
                    <ul className="text-muted-foreground space-y-1 mb-4">
                      <li>
                        you are granted a non-exclusive, limited,
                        non-transferable, non-sublicensable, non-assignable,
                        freely revocable license to access and use the Service
                        for business or personal use;
                      </li>
                      <li>
                        you own all Assets you create with the Services, and
                      </li>
                      <li>
                        we hereby assign to you all rights, title, and interest
                        in and to such Assets for your personal or commercial
                        use.
                      </li>
                    </ul>
                    <p className="text-muted-foreground text-balance mb-6">
                      Otherwise, the Company reserves all rights not expressly
                      granted under these Terms of Use. Each person must have a
                      unique account, and you are responsible for any activity
                      conducted on your account. A breach or violation of any of
                      our Terms of Use may result in an immediate termination of
                      your right to use our Service.
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
                      LIMITATION, THE SUNA WEB APP AND ANY CONTENT) IS PROVIDED
                      "AS IS" AND "AS AVAILABLE" AND IS WITHOUT WARRANTY OF ANY
                      KIND, EXPRESS OR IMPLIED, INCLUDING, BUT NOT LIMITED TO,
                      THE IMPLIED WARRANTIES OF TITLE, NON-INFRINGEMENT,
                      MERCHANTABILITY, AND FITNESS FOR A PARTICULAR PURPOSE, AND
                      ANY WARRANTIES IMPLIED BY ANY COURSE OF PERFORMANCE OR
                      USAGE OF TRADE, ALL OF WHICH ARE EXPRESSLY DISCLAIMED.
                      SUNA DOES NOT GUARANTEE THE ACCURACY, COMPLETENESS, OR
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
                    <p className="text-muted-foreground text-balance mb-6">
                      For questions regarding the Service, you can get in touch
                      by emailing us at{' '}
                      <a
                        href="mailto:legal@kortixai.com"
                        className="text-secondary hover:underline"
                      >
                        legal@kortixai.com
                      </a>
                      .
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
                      References to our "Services" at Suna in this statement
                      include our website, apps, and other products and
                      services. This statement applies to our Services that
                      display or reference this Privacy Statement. Third-party
                      services that we integrate with are governed under their
                      own privacy policies.
                    </p>

                    <p className="text-muted-foreground text-balance mb-6">
                      Suna does not collect biometric or identifying
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
                        href="mailto:legal@kortixai.com"
                        className="text-secondary hover:underline"
                      >
                        legal@kortixai.com
                      </a>
                      .
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-12 text-center pb-10">
              <Link
                href="/"
                className="group inline-flex h-10 items-center justify-center gap-2 text-sm font-medium tracking-wide rounded-full text-primary-foreground dark:text-secondary-foreground px-6 shadow-[inset_0_1px_2px_rgba(255,255,255,0.25),0_3px_3px_-1.5px_rgba(16,24,40,0.06),0_1px_1px_rgba(16,24,40,0.08)] bg-primary hover:bg-primary/90 transition-all duration-200 w-fit"
              >
                <span>Return to Home</span>
                <span className="inline-flex items-center justify-center size-5 rounded-full bg-white/20 group-hover:bg-white/30 transition-colors duration-200">
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className="text-white"
                  >
                    <path
                      d="M7 17L17 7M17 7H8M17 7V16"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </Link>
            </div>
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
