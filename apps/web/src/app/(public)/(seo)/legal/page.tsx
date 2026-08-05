'use client';

import { useTranslations } from 'next-intl';

import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

const LEGAL_LAST_UPDATED = 'April 8, 2026';

function LegalContent() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Get tab from URL or default to "imprint". Terms moved to an external
  // Drive folder (see lib/legal-terms-redirect.ts) and is no longer a tab here.
  const tabParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<'privacy' | 'imprint'>(
    tabParam === 'privacy' || tabParam === 'imprint' ? tabParam : 'imprint',
  );

  // Sync active tab with URL parameter when it changes
  useEffect(() => {
    const validTab =
      tabParam === 'privacy' || tabParam === 'imprint' ? tabParam : 'imprint';
    if (validTab !== activeTab) {
      setActiveTab(validTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabParam]);

  // Handle tab change - updates both state and URL
  const handleTabChange = (tab: 'privacy' | 'imprint') => {
    setActiveTab(tab);
    const params = new URLSearchParams(searchParams);
    params.set('tab', tab);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <main className="bg-background flex min-h-screen w-full flex-col items-center justify-center">
      <section className="w-full pb-20">
        <div className="flex w-full flex-col items-center px-6 pt-10">
          <div className="mx-auto w-full max-w-4xl">
            <div className="mb-10 flex items-center justify-center">
              <h1 className="text-primary text-center text-3xl font-medium tracking-tighter md:text-4xl">
                {tHardcodedUi.raw('appLegalPage.line48JsxTextLegalInformation')}
              </h1>
            </div>

            <div className="mb-8 flex justify-center">
              <div className="border-border flex space-x-4 border-b">
                <button
                  onClick={() => handleTabChange('imprint')}
                  className={cn(
                    'px-4 pb-2',
                    activeTab === 'imprint'
                      ? 'border-primary text-primary border-b-2 font-medium'
                      : 'text-muted-foreground hover:text-primary/80 transition-colors',
                  )}
                >
                  Imprint
                </button>
                <button
                  onClick={() => handleTabChange('privacy')}
                  className={cn(
                    'px-4 pb-2',
                    activeTab === 'privacy'
                      ? 'border-primary text-primary border-b-2 font-medium'
                      : 'text-muted-foreground hover:text-primary/80 transition-colors',
                  )}
                >
                  {tHardcodedUi.raw('appLegalPage.line79JsxTextPrivacyPolicy')}
                </button>
              </div>
            </div>

            <Card>
              <CardContent className="p-8">
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  {activeTab === 'imprint' ? (
                    <div>
                      <h2 className="mb-4 text-2xl font-medium tracking-tight">Imprint</h2>
                      <p className="text-muted-foreground mb-6 text-sm">
                        {tHardcodedUi.raw(
                          'appLegalPage.line93JsxTextInformationAccordingToLegalRequirements',
                        )}
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        {tHardcodedUi.raw('appLegalPage.line97JsxTextCompanyInformation')}
                      </h3>
                      <div className="text-muted-foreground mb-6 space-y-2">
                        <p>
                          <strong>
                            {tHardcodedUi.raw('appLegalPage.line101JsxTextKortixAiCorp')}
                          </strong>
                        </p>
                        <p>
                          {tHardcodedUi.raw(
                            'appLegalPage.line103JsxTextIncorporatedInDelawareUnitedStates',
                          )}
                        </p>
                        <p className="mt-4">
                          <strong>
                            {tHardcodedUi.raw(
                              'appLegalPage.line105JsxTextPrincipalPlaceOfBusiness',
                            )}
                          </strong>
                        </p>
                        <p>{tHardcodedUi.raw('appLegalPage.line107JsxTextText701TilleryStreet')}</p>
                        <p>{tHardcodedUi.raw('appLegalPage.line108JsxTextUnit122521')}</p>
                        <p>{tHardcodedUi.raw('appLegalPage.line109JsxTextAustinTx78702')}</p>
                        <p>{tHardcodedUi.raw('appLegalPage.line110JsxTextUnitedStates')}</p>
                        <p className="mt-4">
                          <strong>
                            {tHardcodedUi.raw('appLegalPage.line112JsxTextRegisteredAgent')}
                          </strong>
                        </p>
                        <p>{tHardcodedUi.raw('appLegalPage.line114JsxTextFirstbaseAgentLlc')}</p>
                        <p>
                          {tHardcodedUi.raw(
                            'appLegalPage.line115JsxTextText1007NOrangeSt4thFloorSuite1382',
                          )}
                        </p>
                        <p>{tHardcodedUi.raw('appLegalPage.line116JsxTextWilmingtonDe19801')}</p>
                        <p>{tHardcodedUi.raw('appLegalPage.line117JsxTextUnitedStates')}</p>
                      </div>

                      <h3 className="text-lg font-medium tracking-tight">Contact</h3>
                      <div className="text-muted-foreground mb-6">
                        <p>
                          Email:{' '}
                          <a href="mailto:info@kortix.com" className="text-primary hover:underline">
                            {tHardcodedUi.raw('appLegalPage.line130JsxTextInfoKortixCom')}
                          </a>
                        </p>
                      </div>

                      <h3 className="text-lg font-medium tracking-tight">
                        {tHardcodedUi.raw('appLegalPage.line136JsxTextResponsibleForContent')}
                      </h3>
                      <p className="text-muted-foreground mb-6">
                        {tHardcodedUi.raw(
                          'appLegalPage.line139JsxTextKortixAiCorpIsResponsibleForTheContent',
                        )}
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">Disclaimer</h3>
                      <p className="text-muted-foreground mb-6 text-balance">
                        {tHardcodedUi.raw(
                          'appLegalPage.line147JsxTextTheInformationProvidedOnThisWebsiteIsFor',
                        )}
                      </p>
                    </div>
                  ) : (
                    <div>
                      <h2 className="mb-4 text-2xl font-medium tracking-tight">
                        {tHardcodedUi.raw('appLegalPage.line1531JsxTextPrivacyPolicy')}
                      </h2>
                      <p className="text-muted-foreground mb-6 text-sm">
                        {tHardcodedUi.raw('appLegalPage.line1534JsxTextLastUpdated')}
                        {LEGAL_LAST_UPDATED}
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">Privacy</h3>
                      <p className="text-muted-foreground mb-6 text-balance">
                        {tHardcodedUi.raw(
                          'appLegalPage.line1541JsxTextOurCommitmentToPrivacyAndDataProtectionIs',
                        )}
                      </p>

                      <p className="text-muted-foreground mb-6 text-balance">
                        {tHardcodedUi.raw(
                          'appLegalPage.line1551JsxTextReferencesToOurServicesAtKortixInThis',
                        )}
                      </p>

                      <p className="text-muted-foreground mb-6 text-balance">
                        {tHardcodedUi.raw(
                          'appLegalPage.line1560JsxTextKortixDoesNotCollectBiometricOrIdentifyingInformation',
                        )}
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        {tHardcodedUi.raw('appLegalPage.line1566JsxTextInformationGathering')}
                      </h3>
                      <p className="text-muted-foreground mb-4 text-balance">
                        {tHardcodedUi.raw(
                          'appLegalPage.line1569JsxTextWeLearnInformationAboutYouWhen',
                        )}
                      </p>

                      <p className="mb-2 font-medium">
                        {tHardcodedUi.raw('appLegalPage.line1573JsxTextYouDirectlyProvideItToUs')}
                      </p>
                      <p className="text-muted-foreground mb-2">
                        {tHardcodedUi.raw('appLegalPage.line1576JsxTextForExampleWeCollect')}
                      </p>
                      <ul className="text-muted-foreground mb-4 space-y-1">
                        <li>
                          {tHardcodedUi.raw(
                            'appLegalPage.line1580JsxTextNameAndContactInformationWeCollectDetailsSuch',
                          )}
                        </li>
                        <li>
                          {tHardcodedUi.raw(
                            'appLegalPage.line1584JsxTextPaymentInformationIfYouMakeAPurchaseWe',
                          )}
                        </li>
                        <li>
                          {tHardcodedUi.raw(
                            'appLegalPage.line1589JsxTextContentAndFilesWeCollectAndRetainThe',
                          )}
                        </li>
                      </ul>

                      <p className="mb-2 font-medium">
                        {tHardcodedUi.raw(
                          'appLegalPage.line1597JsxTextWeCollectItAutomaticallyThroughOurProductsAnd',
                        )}
                      </p>
                      <p className="text-muted-foreground mb-2">
                        {tHardcodedUi.raw('appLegalPage.line1601JsxTextForInstanceWeCollect')}
                      </p>
                      <ul className="text-muted-foreground mb-4 space-y-1">
                        <li>
                          {tHardcodedUi.raw(
                            'appLegalPage.line1605JsxTextIdentifiersAndDeviceInformationWhenYouVisitOur',
                          )}
                        </li>
                        <li>
                          {tHardcodedUi.raw(
                            'appLegalPage.line1613JsxTextGeolocationDataDependingOnYourDeviceAndApp',
                          )}
                        </li>
                        <li>
                          {tHardcodedUi.raw(
                            'appLegalPage.line1618JsxTextUsageDataWeLogYourActivityOnOur',
                          )}
                        </li>
                      </ul>

                      <p className="mb-2 font-medium">
                        {tHardcodedUi.raw(
                          'appLegalPage.line1631JsxTextSomeoneElseTellsUsInformationAboutYou',
                        )}
                      </p>
                      <p className="text-muted-foreground mb-2">
                        {tHardcodedUi.raw(
                          'appLegalPage.line1634JsxTextThirdPartySourcesIncludeForExample',
                        )}
                      </p>
                      <ul className="text-muted-foreground mb-4 space-y-1">
                        <li>
                          {tHardcodedUi.raw(
                            'appLegalPage.line1638JsxTextThirdPartyPartnersThirdPartyApplicationsAndServices',
                          )}
                        </li>
                        <li>
                          {tHardcodedUi.raw(
                            'appLegalPage.line1643JsxTextServiceProvidersThirdPartiesThatCollectOrProvide',
                          )}
                        </li>
                      </ul>

                      <p className="mb-2 font-medium">
                        {tHardcodedUi.raw(
                          'appLegalPage.line1651JsxTextWhenWeTryAndUnderstandMoreAboutYou',
                        )}
                      </p>
                      <p className="text-muted-foreground mb-6 text-balance">
                        {tHardcodedUi.raw(
                          'appLegalPage.line1655JsxTextWeInferNewInformationFromOtherDataWe',
                        )}
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        {tHardcodedUi.raw('appLegalPage.line1663JsxTextInformationUse')}
                      </h3>
                      <p className="text-muted-foreground mb-2 text-balance">
                        {tHardcodedUi.raw(
                          'appLegalPage.line1666JsxTextWeUseEachCategoryOfPersonalInformationAbout',
                        )}
                      </p>
                      <ul className="text-muted-foreground mb-6 space-y-1">
                        <li>
                          {tHardcodedUi.raw(
                            'appLegalPage.line1669JsxTextToProvideYouWithOurServices',
                          )}
                        </li>
                        <li>
                          {tHardcodedUi.raw(
                            'appLegalPage.line1670JsxTextToImproveAndDevelopOurServices',
                          )}
                        </li>
                        <li>
                          {tHardcodedUi.raw('appLegalPage.line1671JsxTextToCommunicateWithYou')}
                        </li>
                        <li>
                          {tHardcodedUi.raw('appLegalPage.line1672JsxTextToProvideCustomerSupport')}
                        </li>
                      </ul>

                      <h3 className="text-lg font-medium tracking-tight">
                        {tHardcodedUi.raw('appLegalPage.line1676JsxTextInformationSharing')}
                      </h3>
                      <p className="text-muted-foreground mb-2 text-balance">
                        {tHardcodedUi.raw('appLegalPage.line1679JsxTextWeShareInformationAboutYou')}
                      </p>
                      <ul className="text-muted-foreground mb-4 space-y-1">
                        <li>
                          {tHardcodedUi.raw(
                            'appLegalPage.line1683JsxTextWhenWeVeAskedReceivedYourConsentTo',
                          )}
                        </li>
                        <li>
                          {tHardcodedUi.raw(
                            'appLegalPage.line1686JsxTextAsNeededIncludingToThirdPartyServiceProviders',
                          )}
                        </li>
                        <li>
                          {tHardcodedUi.raw(
                            'appLegalPage.line1693JsxTextToComplyWithLawsOrToRespondTo',
                          )}
                        </li>
                        <li>
                          {tHardcodedUi.raw(
                            'appLegalPage.line1700JsxTextOnlyIfWeReasonablyBelieveItSNecessary',
                          )}
                        </li>
                        <li>
                          {tHardcodedUi.raw(
                            'appLegalPage.line1705JsxTextInTheEventOfACorporateRestructuringOr',
                          )}
                        </li>
                      </ul>

                      <p className="text-muted-foreground mb-4 text-balance">
                        {tHardcodedUi.raw(
                          'appLegalPage.line1712JsxTextPleaseNoteThatSomeOfOurServicesInclude',
                        )}
                      </p>

                      <p className="text-muted-foreground mb-6 text-balance">
                        {tHardcodedUi.raw(
                          'appLegalPage.line1721JsxTextFinallyWeMayShareNonPersonalInformationIn',
                        )}
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        {tHardcodedUi.raw('appLegalPage.line1726JsxTextInformationProtection')}
                      </h3>
                      <p className="text-muted-foreground mb-6 text-balance">
                        {tHardcodedUi.raw(
                          'appLegalPage.line1729JsxTextWeImplementPhysicalBusinessAndTechnicalSecurityMeasures',
                        )}
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        {tHardcodedUi.raw('appLegalPage.line1739JsxTextContactUs')}
                      </h3>
                      <p className="text-muted-foreground text-balance">
                        {tHardcodedUi.raw(
                          'appLegalPage.line1742JsxTextYouCanGetInTouchByEmailingUs',
                        )}{' '}
                        <a href="mailto:info@kortix.com" className="text-primary hover:underline">
                          {tHardcodedUi.raw('appLegalPage.line1747JsxTextInfoKortixCom')}
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
      fallback={<div className="flex min-h-screen items-center justify-center">Loading...</div>}
    >
      <LegalContent />
    </Suspense>
  );
}
