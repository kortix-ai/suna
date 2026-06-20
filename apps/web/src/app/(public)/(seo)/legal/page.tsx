'use client';

import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';

const LEGAL_LAST_UPDATED = 'April 8, 2026';

function LegalContent() {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
              <h1 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-primary">{tHardcodedUi.raw('appLegalPage.line48JsxTextLegalInformation')}</h1>
            </div>

            <div className="flex justify-center mb-8">
              <div className="flex space-x-4 border-b border-border">
                <button
                  onClick={() => handleTabChange('imprint')}
                  className={cn('pb-2 px-4', activeTab === 'imprint'
                      ? 'border-b-2 border-primary font-medium text-primary'
                      : 'text-muted-foreground hover:text-primary/80 transition-colors'
                    )}
                >
                  Imprint
                </button>
                <button
                  onClick={() => handleTabChange('terms')}
                  className={cn('pb-2 px-4', activeTab === 'terms'
                      ? 'border-b-2 border-primary font-medium text-primary'
                      : 'text-muted-foreground hover:text-primary/80 transition-colors'
                    )}
                >{tHardcodedUi.raw('appLegalPage.line70JsxTextTermsOfService')}</button>
                <button
                  onClick={() => handleTabChange('privacy')}
                  className={cn('pb-2 px-4', activeTab === 'privacy'
                      ? 'border-b-2 border-primary font-medium text-primary'
                      : 'text-muted-foreground hover:text-primary/80 transition-colors'
                    )}
                >{tHardcodedUi.raw('appLegalPage.line79JsxTextPrivacyPolicy')}</button>
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
                      <p className="text-sm text-muted-foreground mb-6">{tHardcodedUi.raw('appLegalPage.line93JsxTextInformationAccordingToLegalRequirements')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line97JsxTextCompanyInformation')}</h3>
                      <div className="text-muted-foreground mb-6 space-y-2">
                        <p>
                          <strong>{tHardcodedUi.raw('appLegalPage.line101JsxTextKortixAiCorp')}</strong>
                        </p>
                        <p>{tHardcodedUi.raw('appLegalPage.line103JsxTextIncorporatedInDelawareUnitedStates')}</p>
                        <p className="mt-4">
                          <strong>{tHardcodedUi.raw('appLegalPage.line105JsxTextPrincipalPlaceOfBusiness')}</strong>
                        </p>
                        <p>{tHardcodedUi.raw('appLegalPage.line107JsxTextText701TilleryStreet')}</p>
                        <p>{tHardcodedUi.raw('appLegalPage.line108JsxTextUnit122521')}</p>
                        <p>{tHardcodedUi.raw('appLegalPage.line109JsxTextAustinTx78702')}</p>
                        <p>{tHardcodedUi.raw('appLegalPage.line110JsxTextUnitedStates')}</p>
                        <p className="mt-4">
                          <strong>{tHardcodedUi.raw('appLegalPage.line112JsxTextRegisteredAgent')}</strong>
                        </p>
                        <p>{tHardcodedUi.raw('appLegalPage.line114JsxTextFirstbaseAgentLlc')}</p>
                        <p>{tHardcodedUi.raw('appLegalPage.line115JsxTextText1007NOrangeSt4thFloorSuite1382')}</p>
                        <p>{tHardcodedUi.raw('appLegalPage.line116JsxTextWilmingtonDe19801')}</p>
                        <p>{tHardcodedUi.raw('appLegalPage.line117JsxTextUnitedStates')}</p>
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
                          >{tHardcodedUi.raw('appLegalPage.line130JsxTextInfoKortixCom')}</a>
                        </p>
                      </div>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line136JsxTextResponsibleForContent')}</h3>
                      <p className="text-muted-foreground mb-6">{tHardcodedUi.raw('appLegalPage.line139JsxTextKortixAiCorpIsResponsibleForTheContent')}</p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Disclaimer
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line147JsxTextTheInformationProvidedOnThisWebsiteIsFor')}</p>
                    </div>
                  ) : activeTab === 'terms' ? (
                    <div>
                      <h2 className="text-2xl font-medium tracking-tight mb-4">{tHardcodedUi.raw('appLegalPage.line159JsxTextTermsOfService')}</h2>
                      <p className="text-sm text-muted-foreground mb-6">{tHardcodedUi.raw('appLegalPage.line162JsxTextLastUpdated')}{LEGAL_LAST_UPDATED}
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line166JsxTextTermsOfServicePrivacyPolicy')}</h3>
                      <p className="text-muted-foreground text-balance mb-4">{tHardcodedUi.raw('appLegalPage.line169JsxTextLastUpdatedAndEffectiveDate')}{LEGAL_LAST_UPDATED}
                      </p>

                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line173JsxTextPleaseReadTheseTermsOfUseAgreementOr')}</p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Definitions
                      </h3>
                      <ul className="text-muted-foreground space-y-1 mb-6">
                        <li>{tHardcodedUi.raw('appLegalPage.line188JsxTextCompanyRefersToKortixAiCorpADelaware')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line193JsxTextSiteRefersToTheKortixWebsiteIncludingAny')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line198JsxTextServiceRefersToTheKortixPlatformAndAll')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line205JsxTextAgentRefersToAnAutonomousAiWorkerCreated')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line210JsxTextAgentActionsRefersToAnyAutonomousOperationsPerformed')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line216JsxTextUserRefersToAnyIndividualOrEntityUsing')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line220JsxTextAccountRefersToAUserAccountWithAssociated')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line224JsxTextTeamMemberRefersToAnInvitedUserOn')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line228JsxTextApiRefersToProgrammaticAccessToTheService')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line232JsxTextApiKeyRefersToAuthenticationCredentialsIssuedBy')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line236JsxTextContentRefersToAnyTextImagesCodeOr')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line241JsxTextAssetsRefersToTheResultsAndOutputsGenerated')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line246JsxTextThirdPartyServicesRefersToExternalServicesIntegrated')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line252JsxTextSelfHostingRefersToDeploymentOfTheService')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line257JsxTextTermsOfUseRefersToTheseTermsAnd')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line261JsxTextLicenseRefersToThePermissionsGrantedToUsers')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line266JsxTextDmcaRefersToTheDigitalMillenniumCopyrightAct')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line269JsxTextFeesRefersToTheSubscriptionOrOtherPayments')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line275JsxTextNoticeAddressRefersToTheContactAddressFor')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line279JsxTextPrivacyPolicyRefersToTheDocumentOutliningHow')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line283JsxTextThirdPartyRefersToAnyPersonOrEntity')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line287JsxTextAaaRulesRefersToTheAmericanArbitrationAssociation')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line291JsxTextClaimRefersToAnyDisputeClaimDemandOr')}</li>
                      </ul>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line297JsxTextAcceptanceOfTermsOfUse')}</h3>
                      <p className="text-muted-foreground text-balance mb-4">{tHardcodedUi.raw('appLegalPage.line300JsxTextTheServiceIsOfferedSubjectToAcceptanceWithout')}</p>

                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line313JsxTextTheCompanyMayInItsSoleDiscretionRefuse')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line321JsxTextDescriptionOfService')}</h3>
                      <p className="text-muted-foreground text-balance mb-4">{tHardcodedUi.raw('appLegalPage.line324JsxTextKortixIsACompletePlatformForCreatingManaging')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          <strong>{tHardcodedUi.raw('appLegalPage.line331JsxTextAgentBuilder')}</strong>{tHardcodedUi.raw('appLegalPage.line331JsxTextToolsToCreateConfigureAndCustomizeAiAgents')}</li>
                        <li>
                          <strong>{tHardcodedUi.raw('appLegalPage.line336JsxTextBrowserAutomation')}</strong>{tHardcodedUi.raw('appLegalPage.line336JsxTextAgentsCanNavigateWebsitesExtractDataFillForms')}</li>
                        <li>
                          <strong>{tHardcodedUi.raw('appLegalPage.line340JsxTextFileManagement')}</strong>{tHardcodedUi.raw('appLegalPage.line340JsxTextAgentsCanCreateEditAndOrganizeDocumentsSpreadsheets')}</li>
                        <li>
                          <strong>{tHardcodedUi.raw('appLegalPage.line344JsxTextWebIntelligence')}</strong>{tHardcodedUi.raw('appLegalPage.line344JsxTextWebCrawlingSearchCapabilitiesDataExtractionAndInformation')}</li>
                        <li>
                          <strong>{tHardcodedUi.raw('appLegalPage.line348JsxTextSystemOperations')}</strong>{tHardcodedUi.raw('appLegalPage.line348JsxTextCommandLineExecutionSystemAdministrationAndDevopsTask')}</li>
                        <li>
                          <strong>{tHardcodedUi.raw('appLegalPage.line352JsxTextApiIntegrations')}</strong>{tHardcodedUi.raw('appLegalPage.line352JsxTextConnectionWith2700ThirdPartyServicesViaComposio')}</li>
                        <li>
                          <strong>{tHardcodedUi.raw('appLegalPage.line357JsxTextMultiTenantArchitecture')}</strong>{tHardcodedUi.raw('appLegalPage.line357JsxTextAccountManagementTeamCollaborationSharedResourcesAndApi')}</li>
                        <li>
                          <strong>{tHardcodedUi.raw('appLegalPage.line361JsxTextSelfHostingOptions')}</strong>{tHardcodedUi.raw('appLegalPage.line361JsxTextDeploymentOnYourOwnInfrastructureSubjectToLicense')}</li>
                        <li>
                          <strong>{tHardcodedUi.raw('appLegalPage.line365JsxTextApiAndSdkAccess')}</strong>{tHardcodedUi.raw('appLegalPage.line365JsxTextProgrammaticAccessViaRestEndpointsAndPythonSdk')}</li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line370JsxTextAgentsOperateAutonomouslyBasedOnYourInstructionsAnd')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line378JsxTextRulesAndConduct')}</h3>
                      <p className="text-muted-foreground text-balance mb-4">{tHardcodedUi.raw('appLegalPage.line381JsxTextByUsingTheServiceYouAgreeThatIt')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line397JsxTextContentModerationProhibitedUses')}</h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line400JsxTextUserResponsibilityForAgentOutputs')}</strong>{tHardcodedUi.raw('appLegalPage.line400JsxTextYouAreResponsibleForReviewingAllAgentOutputs')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line408JsxTextProhibitedUses')}</strong>{tHardcodedUi.raw('appLegalPage.line408JsxTextAsAConditionOfUseYouPromiseNot')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>{tHardcodedUi.raw('appLegalPage.line416JsxTextWouldConstituteAViolationOfAnyApplicableLaw')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line420JsxTextInfringesUponAnyIntellectualPropertyOrOtherRight')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line424JsxTextIsThreateningAbusiveHarassingDefamatoryLibelousDeceptiveFraudulent')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line429JsxTextCreatesAssetsOrAgentOutputsThatExploitOr')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line432JsxTextGeneratesOrDisseminatesVerifiablyFalseInformationWithThe')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line436JsxTextImpersonatesOrAttemptsToImpersonateOthers')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line439JsxTextGeneratesOrDisseminatesPersonallyIdentifyingOrIdentifiableInformation')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line443JsxTextCreatesAssetsThatImplyOrPromoteSupportOf')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line447JsxTextCreatesAssetsThatCondoneOrPromoteViolenceAgainst')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line451JsxTextUsesAgentsToCircumventSecurityMeasuresAuthenticationSystems')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line455JsxTextUsesAgentsForAutomatedScrapingAtScaleWithout')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line459JsxTextUsesAgentsForCompetitiveIntelligenceGatheringThroughUnauthorized')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line463JsxTextUsesAgentsToReverseEngineerDecompileOrDisassemble')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line467JsxTextUsesAgentsForSecurityTestingPenetrationTestingOr')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line471JsxTextUsesAgentsToInterfereWithDisruptOrDamage')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line475JsxTextUsesAgentsToSendUnsolicitedCommunicationsSpamOr')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line479JsxTextUsesAgentsToAccessModifyOrDeleteData')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line483JsxTextUsesAgentsInAMannerThatViolatesExport')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line487JsxTextUsesAgentsToCreateOrDistributeMalwareViruses')}</li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line492JsxTextThirdPartyServiceCompliance')}</strong>{tHardcodedUi.raw('appLegalPage.line492JsxTextWhenUsingAgentsToInteractWithThirdParty')}</p>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>{tHardcodedUi.raw('appLegalPage.line499JsxTextContentRemoval')}</strong>{tHardcodedUi.raw('appLegalPage.line499JsxTextTheCompanyReservesTheRightToRemoveAny')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line508JsxTextUserResponsibilityForCreatedContent')}</h3>
                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line511JsxTextYouAgreeNotToCreateAnyContentOr')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line525JsxTextAgentAutonomyLiability')}</h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line528JsxTextAutonomousOperation')}</strong>{tHardcodedUi.raw('appLegalPage.line528JsxTextAgentsCreatedThroughTheServiceOperateAutonomouslyBased')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line535JsxTextUserResponsibility')}</strong>{tHardcodedUi.raw('appLegalPage.line535JsxTextYouAreSolelyResponsibleForAllAgentActions')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>{tHardcodedUi.raw('appLegalPage.line540JsxTextAllActionsPerformedByAgentsOnYourBehalf')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line544JsxTextAllContentDataOrOutputsGeneratedByAgents')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line547JsxTextAgentInteractionsWithThirdPartyServicesWebsitesOr')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line551JsxTextAgentAccessToModificationOfOrDeletionOf')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line555JsxTextComplianceWithAllApplicableLawsRegulationsAndThird')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line559JsxTextEnsuringYouHaveNecessaryRightsPermissionsAndAuthorizations')}</li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line564JsxTextCompanyDisclaimers')}</strong>{tHardcodedUi.raw('appLegalPage.line564JsxTextTheCompanyDisclaimsAllLiabilityFor')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>{tHardcodedUi.raw('appLegalPage.line569JsxTextAgentErrorsMalfunctionsBugsOrUnintendedActions')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line572JsxTextDataLossCorruptionOrUnauthorizedAccessResultingFrom')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line576JsxTextUnauthorizedAgentActionsIncludingActionsBeyondTheScope')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line580JsxTextThirdPartyServiceFailuresOutagesOrChangesThat')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line584JsxTextAgentGeneratedContentThatViolatesLawsRegulationsOr')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line588JsxTextSecurityBreachesOrVulnerabilitiesInAgentConfigurationsOr')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line592JsxTextFinancialLossesBusinessInterruptionsOrOtherConsequencesOf')}</li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line597JsxTextMonitoringAndReview')}</strong>{tHardcodedUi.raw('appLegalPage.line597JsxTextYouAcknowledgeThatAgentsOperateAutonomouslyAndThat')}</p>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>Indemnification.</strong>{tHardcodedUi.raw('appLegalPage.line604JsxTextYouAgreeToIndemnifyDefendAndHoldHarmless')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line619JsxTextSoftwareLicense')}</h3>
                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line622JsxTextForTheFullLicenseTermsPleaseReferTo')}{' '}
                        <a
                          href="https://github.com/kortix-ai/suna/blob/main/LICENSE"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          github.com/kortix-ai/suna/blob/main/LICENSE
                        </a>
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line634JsxTextAccuracyDisclaimer')}</h3>
                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line637JsxTextTheServiceIsProvidedForGeneralAssistancePurposes')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line646JsxTextDmcaAndTakedownsPolicy')}</h3>
                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line649JsxTextTheCompanyUtilizesArtificialIntelligenceSystemsToGenerate')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line663JsxTextDataRetentionDeletionAndUserRights')}</h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line666JsxTextDataRetention')}</strong>{tHardcodedUi.raw('appLegalPage.line666JsxTextTheCompanyRetainsYourDataForAsLong')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line676JsxTextYourRights')}</strong>{tHardcodedUi.raw('appLegalPage.line676JsxTextYouHaveTheRightTo')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          <strong>Access:</strong>{tHardcodedUi.raw('appLegalPage.line680JsxTextRequestAccessToYourPersonalDataAndInformation')}</li>
                        <li>
                          <strong>Export:</strong>{tHardcodedUi.raw('appLegalPage.line684JsxTextRequestExportOfYourDataInAMachine')}</li>
                        <li>
                          <strong>Correction:</strong>{tHardcodedUi.raw('appLegalPage.line688JsxTextRequestCorrectionOfInaccurateOrIncompleteData')}</li>
                        <li>
                          <strong>Deletion:</strong>{tHardcodedUi.raw('appLegalPage.line692JsxTextRequestDeletionOfYourAccountAndAssociatedData')}</li>
                        <li>
                          <strong>Portability:</strong>{tHardcodedUi.raw('appLegalPage.line696JsxTextRequestTransferOfYourDataToAnotherService')}</li>
                        <li>
                          <strong>Objection:</strong>{tHardcodedUi.raw('appLegalPage.line700JsxTextObjectToCertainTypesOfDataProcessing')}</li>
                        <li>
                          <strong>Restriction:</strong>{tHardcodedUi.raw('appLegalPage.line704JsxTextRequestRestrictionOfDataProcessingInCertainCircumstances')}</li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">{tHardcodedUi.raw('appLegalPage.line709JsxTextToExerciseTheseRightsPleaseContactUsAt')}{' '}
                        <a
                          href="mailto:info@kortix.com"
                          className="text-primary hover:underline"
                        >{tHardcodedUi.raw('appLegalPage.line714JsxTextInfoKortixCom')}</a>{tHardcodedUi.raw('appLegalPage.line716JsxTextWeWillRespondToYourRequestWithinA')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line720JsxTextGdprRightsEuUsers')}</strong>{tHardcodedUi.raw('appLegalPage.line720JsxTextIfYouAreLocatedInTheEuropeanUnion')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>{tHardcodedUi.raw('appLegalPage.line726JsxTextRightToBeInformedAboutDataProcessing')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line729JsxTextRightOfAccessToYourPersonalData')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line732JsxTextRightToRectificationOfInaccurateData')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line735JsxTextRightToErasureRightToBeForgotten')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line738JsxTextRightToRestrictProcessing')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line741JsxTextRightToDataPortability')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line744JsxTextRightToObjectToProcessing')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line747JsxTextRightsRelatedToAutomatedDecisionMakingAndProfiling')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line750JsxTextRightToLodgeAComplaintWithASupervisory')}</li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">{tHardcodedUi.raw('appLegalPage.line754JsxTextForGdprRelatedRequestsPleaseContactUsAt')}{' '}
                        <a
                          href="mailto:info@kortix.com"
                          className="text-primary hover:underline"
                        >{tHardcodedUi.raw('appLegalPage.line759JsxTextInfoKortixCom')}</a>{tHardcodedUi.raw('appLegalPage.line761JsxTextOurLegalBasisForProcessingYourDataIncludes')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line767JsxTextCcpaRightsCaliforniaUsers')}</strong>{tHardcodedUi.raw('appLegalPage.line767JsxTextIfYouAreACaliforniaResidentYouHave')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>
                          <strong>{tHardcodedUi.raw('appLegalPage.line773JsxTextRightToKnow')}</strong>{tHardcodedUi.raw('appLegalPage.line773JsxTextRequestDisclosureOfCategoriesAndSpecificPiecesOf')}</li>
                        <li>
                          <strong>{tHardcodedUi.raw('appLegalPage.line778JsxTextRightToDelete')}</strong>{tHardcodedUi.raw('appLegalPage.line778JsxTextRequestDeletionOfPersonalInformationCollectedFromYou')}</li>
                        <li>
                          <strong>{tHardcodedUi.raw('appLegalPage.line782JsxTextRightToOptOut')}</strong>{tHardcodedUi.raw('appLegalPage.line782JsxTextOptOutOfTheSaleOfPersonalInformation')}</li>
                        <li>
                          <strong>{tHardcodedUi.raw('appLegalPage.line786JsxTextRightToNonDiscrimination')}</strong>{tHardcodedUi.raw('appLegalPage.line786JsxTextExerciseYourRightsWithoutDiscrimination')}</li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">{tHardcodedUi.raw('appLegalPage.line791JsxTextCategoriesOfPersonalInformationWeCollectIncludeIdentifiers')}</p>
                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line798JsxTextToExerciseYourCcpaRightsPleaseContactUs')}{' '}
                        <a
                          href="mailto:info@kortix.com"
                          className="text-primary hover:underline"
                        >{tHardcodedUi.raw('appLegalPage.line803JsxTextInfoKortixCom')}</a>{tHardcodedUi.raw('appLegalPage.line805JsxTextWeMayRequireVerificationOfYourIdentityBefore')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line811JsxTextFeesAndPayments')}</h3>
                      <p className="text-muted-foreground text-balance mb-4">{tHardcodedUi.raw('appLegalPage.line814JsxTextTheCompanyMayOfferPaidServicesYouCan')}</p>

                      <p className="text-muted-foreground text-balance mb-4">{tHardcodedUi.raw('appLegalPage.line828JsxTextUnlessOtherwiseStatedYourSubscriptionFeesFeesDo')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line840JsxTextUsageBasedBilling')}</strong>{tHardcodedUi.raw('appLegalPage.line840JsxTextSomeFeaturesOfTheServiceMayBeSubject')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line849JsxTextCreditSystem')}</strong>{tHardcodedUi.raw('appLegalPage.line849JsxTextTheServiceMayUtilizeACreditSystemWhere')}</p>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>{tHardcodedUi.raw('appLegalPage.line856JsxTextPaymentMethods')}</strong>{tHardcodedUi.raw('appLegalPage.line856JsxTextPaymentsMustBeMadeInUSDollars')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line864JsxTextServiceAvailabilityModifications')}</h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line867JsxTextServiceAvailability')}</strong>{tHardcodedUi.raw('appLegalPage.line867JsxTextTheServiceIsProvidedAsIsAndAs')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line876JsxTextPlannedMaintenance')}</strong>{tHardcodedUi.raw('appLegalPage.line876JsxTextTheCompanyMayPerformPlannedMaintenanceThatMay')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line883JsxTextServiceModifications')}</strong>{tHardcodedUi.raw('appLegalPage.line883JsxTextTheCompanyReservesTheRightToModifyUpdate')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line891JsxTextFeatureDeprecation')}</strong>{tHardcodedUi.raw('appLegalPage.line891JsxTextTheCompanyMayDeprecateFeaturesApisOrFunctionality')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line898JsxTextServiceSuspension')}</strong>{tHardcodedUi.raw('appLegalPage.line898JsxTextTheCompanyReservesTheRightToSuspendOr')}</p>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>{tHardcodedUi.raw('appLegalPage.line905JsxTextNoGuarantees')}</strong>{tHardcodedUi.raw('appLegalPage.line905JsxTextTheCompanyDoesNotGuaranteeThatTheService')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line914JsxTextApiUsageRateLimits')}</h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line917JsxTextApiAccess')}</strong>{tHardcodedUi.raw('appLegalPage.line917JsxTextTheServiceProvidesProgrammaticAccessViaRestEndpoints')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line924JsxTextApiKeySecurity')}</strong>{tHardcodedUi.raw('appLegalPage.line924JsxTextYouMustNotSharePublishOrExposeYour')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line932JsxTextRateLimitsFairUse')}</strong>{tHardcodedUi.raw('appLegalPage.line932JsxTextTheServiceIsSubjectToRateLimitsAnd')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>{tHardcodedUi.raw('appLegalPage.line940JsxTextExceedRateLimitsOrAttemptToCircumventRate')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line944JsxTextUseAutomatedToolsOrScriptsToMakeExcessive')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line947JsxTextEngageInAnyActivityThatPlacesUndueBurden')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line951JsxTextUseTheApiInAMannerThatInterferes')}</li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line956JsxTextUsageQuotas')}</strong>{tHardcodedUi.raw('appLegalPage.line956JsxTextYourSubscriptionPlanMayIncludeUsageQuotasFor')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line963JsxTextAbuseEnforcement')}</strong>{tHardcodedUi.raw('appLegalPage.line963JsxTextTheCompanyMonitorsApiUsageForAbuseFraud')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>{tHardcodedUi.raw('appLegalPage.line970JsxTextTemporarilyOrPermanentlySuspendYourApiAccess')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line973JsxTextRevokeYourApiKeys')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line976JsxTextTerminateYourAccount')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line979JsxTextTakeLegalActionIfNecessary')}</li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>{tHardcodedUi.raw('appLegalPage.line983JsxTextApiChanges')}</strong>{tHardcodedUi.raw('appLegalPage.line983JsxTextTheCompanyReservesTheRightToModifyDeprecate')}</p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Termination
                      </h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line995JsxTextTerminationByCompany')}</strong>{tHardcodedUi.raw('appLegalPage.line995JsxTextTheCompanyMayTerminateYourAccessToAll')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1003JsxTextTerminationByUser')}</strong>{tHardcodedUi.raw('appLegalPage.line1003JsxTextYouMayTerminateYourAccountAtAnyTime')}{' '}
                        <a
                          href="mailto:info@kortix.com"
                          className="text-primary hover:underline"
                        >{tHardcodedUi.raw('appLegalPage.line1010JsxTextInfoKortixCom')}</a>{tHardcodedUi.raw('appLegalPage.line1012JsxTextTerminationOfYourAccountWillResultInThe')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1016JsxTextDataDeletion')}</strong>{tHardcodedUi.raw('appLegalPage.line1016JsxTextUponTerminationTheCompanyWillDeleteOrAnonymize')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1025JsxTextOutstandingObligations')}</strong>{tHardcodedUi.raw('appLegalPage.line1025JsxTextAnyFeesPaidHereunderAreNonRefundableUpon')}</p>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>Survival.</strong>{tHardcodedUi.raw('appLegalPage.line1031JsxTextUponAnyTerminationAllRightsAndLicensesGranted')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line1041JsxTextDisputeResolutionByBindingArbitration')}</h3>
                      <p className="text-muted-foreground text-balance mb-4">{tHardcodedUi.raw('appLegalPage.line1044JsxTextPleaseReadThisSectionCarefullyAsItAffects')}</p>

                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1049JsxTextAgreementToArbitrate')}</strong>{tHardcodedUi.raw('appLegalPage.line1049JsxTextYouAndTheCompanyAgreeThatAnyAnd')}</p>

                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1065JsxTextProhibitionOfClassAndRepresentativeActions')}</strong>{' '}{tHardcodedUi.raw('appLegalPage.line1067JsxTextYouAndWeAgreeThatEachOfUs')}</p>

                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1074JsxTextPreArbitrationDisputeResolution')}</strong>{' '}{tHardcodedUi.raw('appLegalPage.line1075JsxTextBeforeCommencingAnyArbitrationYouAgreeToProvide')}</p>

                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line1086JsxTextBothPartiesAgreeThatTheyWillAttemptTo')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line1095JsxTextChoiceOfLaw')}</h3>
                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line1098JsxTextAnyAndAllClaimsShallBeGovernedBy')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line1111JsxTextThirdPartyServicesIntegrations')}</h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1114JsxTextThirdPartyIntegrations')}</strong>{tHardcodedUi.raw('appLegalPage.line1114JsxTextTheServiceIntegratesWithNumerousThirdPartyServices')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1122JsxTextYourResponsibility')}</strong>{tHardcodedUi.raw('appLegalPage.line1122JsxTextWhenUsingAgentsToInteractWithThirdParty')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>{tHardcodedUi.raw('appLegalPage.line1128JsxTextComplianceWithAllThirdPartyTermsOfService')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1132JsxTextObtainingNecessaryAuthorizationsLicensesAndPermissionsToAccess')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1136JsxTextEnsuringYourUseOfThirdPartyServicesThrough')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1140JsxTextAnyFeesChargesOrCostsImposedByThird')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1143JsxTextDataPrivacyAndSecurityWhenSharingDataWith')}</li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1148JsxTextCompanyDisclaimers')}</strong>{tHardcodedUi.raw('appLegalPage.line1148JsxTextTheCompanyIsNotResponsibleFor')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>{tHardcodedUi.raw('appLegalPage.line1153JsxTextThirdPartyServiceAvailabilityOutagesOrChanges')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1156JsxTextThirdPartyServiceFailuresThatAffectAgentFunctionality')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1159JsxTextThirdPartyServiceModificationsDeprecationsOrDiscontinuations')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1163JsxTextDataHandlingPrivacyPracticesOrSecurityOfThird')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1167JsxTextViolationsOfThirdPartyTermsByYourAgents')}</li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1172JsxTextDataSharing')}</strong>{tHardcodedUi.raw('appLegalPage.line1172JsxTextWhenYouUseAgentsToInteractWithThird')}</p>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1180JsxTextThirdPartyServiceChanges')}</strong>{tHardcodedUi.raw('appLegalPage.line1180JsxTextThirdPartyServicesMayChangeTheirApisTerms')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line1190JsxTextExportControlCompliance')}</h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1193JsxTextComplianceWithExportLaws')}</strong>{tHardcodedUi.raw('appLegalPage.line1193JsxTextTheServiceIncludingSoftwareTechnologyAndTechnicalData')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1201JsxTextProhibitedCountriesUsers')}</strong>{tHardcodedUi.raw('appLegalPage.line1201JsxTextYouRepresentAndWarrantThatYouAreNot')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1210JsxTextRestrictedUses')}</strong>{tHardcodedUi.raw('appLegalPage.line1210JsxTextYouAgreeNotToUseTheServiceIn')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>{tHardcodedUi.raw('appLegalPage.line1216JsxTextExportingReExportingOrTransferringTheServiceTo')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1220JsxTextUsingTheServiceForPurposesProhibitedByExport')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1224JsxTextFacilitatingTransactionsOrActivitiesThatViolateExportControl')}</li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1229JsxTextCompanyRights')}</strong>{tHardcodedUi.raw('appLegalPage.line1229JsxTextTheCompanyReservesTheRightToRestrictAccess')}</p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Self-Hosting
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line1242JsxTextTheServiceSoftwareIsAvailableForSelfHosting')}{' '}
                        <a
                          href="mailto:hey@kortix.com"
                          className="text-primary hover:underline"
                        >{tHardcodedUi.raw('appLegalPage.line1255JsxTextHeyKortixCom')}</a>
                        {' '}{tHardcodedUi.raw('appLegalPage.line1257JsxTextForCommercialLicensingInquiries')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line1261JsxTextLinksToAndFromOtherWebsites')}</h3>
                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line1264JsxTextYouMayGainAccessToOtherWebsitesVia')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line1274JsxTextModificationOfTermsOfUse')}</h3>
                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line1277JsxTextAtItsSoleDiscretionTheCompanyMayModify')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line1292JsxTextTrademarksAndPatents')}</h3>
                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line1295JsxTextAllKortixLogosMarksAndDesignationsAreTrademarks')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line1307JsxTextIntellectualPropertyOwnership')}</h3>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1310JsxTextServiceLicense')}</strong>{tHardcodedUi.raw('appLegalPage.line1310JsxTextSubjectToYourComplianceWithThisAgreementThe')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1318JsxTextUserOwnershipOfAssets')}</strong>{tHardcodedUi.raw('appLegalPage.line1318JsxTextYouOwnAllAssetsYouCreateWithThe')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>{tHardcodedUi.raw('appLegalPage.line1323JsxTextGeneratedContentCodeDocumentsReportsPresentationsAndOther')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1327JsxTextAgentConfigurationsPromptsAndCustomizationsCreatedByYou')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1331JsxTextDerivativeWorksBasedOnAgentOutputs')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1334JsxTextDataFilesAndContentYouUploadOrProvide')}</li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">{tHardcodedUi.raw('appLegalPage.line1338JsxTextTheCompanyHerebyAssignsToYouAllRights')}</p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1343JsxTextCompanyRetainedRights')}</strong>{tHardcodedUi.raw('appLegalPage.line1343JsxTextTheCompanyRetainsAllRightsInAndTo')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>{tHardcodedUi.raw('appLegalPage.line1348JsxTextTheServicePlatformSoftwareInfrastructureAndTechnology')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1351JsxTextPreExistingTrainingDataModelsAndAlgorithmsUsed')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1356JsxTextAgentTemplatesExamplesAndPreConfiguredAgentsProvided')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1360JsxTextImprovementsModificationsAndEnhancementsToThePlatformItself')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1364JsxTextCompanyTrademarksLogosAndBranding')}</li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1368JsxTextLicenseToCompany')}</strong>{tHardcodedUi.raw('appLegalPage.line1368JsxTextYouGrantTheCompanyAWorldwideNonExclusive')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>{tHardcodedUi.raw('appLegalPage.line1375JsxTextProvidingMaintainingAndImprovingTheService')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1378JsxTextAnalyticsMonitoringAndServiceOptimization')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1381JsxTextComplianceWithLegalObligationsAndEnforcementOfThese')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1385JsxTextSecurityFraudPreventionAndAbuseDetection')}</li>
                      </ul>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1389JsxTextThirdPartyContent')}</strong>{tHardcodedUi.raw('appLegalPage.line1389JsxTextIfYourAssetsIncorporateThirdPartyContentMaterials')}</p>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1396JsxTextAccountResponsibility')}</strong>{tHardcodedUi.raw('appLegalPage.line1396JsxTextEachPersonMustHaveAUniqueAccountAnd')}</p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Indemnification
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line1408JsxTextYouShallDefendIndemnifyAndHoldHarmlessThe')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line1424JsxTextLimitationOfLiability')}</h3>
                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line1427JsxTextInNoEventShallTheCompanyOrIts')}</p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Disclaimer
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line1448JsxTextAllUseOfTheServiceAndAnyContent')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line1466JsxTextAgeRequirements')}</h3>
                      <p className="text-muted-foreground text-balance mb-4">{tHardcodedUi.raw('appLegalPage.line1469JsxTextByAccessingTheServicesYouConfirmThatYou')}</p>

                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line1477JsxTextPleaseAskYourParentOrGuardianToRead')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line1486JsxTextContactUs')}</h3>
                      <p className="text-muted-foreground text-balance mb-4">{tHardcodedUi.raw('appLegalPage.line1489JsxTextForQuestionsRegardingTheServiceYouCanGet')}{' '}
                        <a
                          href="mailto:info@kortix.com"
                          className="text-primary hover:underline"
                        >{tHardcodedUi.raw('appLegalPage.line1495JsxTextInfoKortixCom')}</a>
                        .
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1500JsxTextLegalMatters')}</strong>{tHardcodedUi.raw('appLegalPage.line1500JsxTextForLegalInquiriesDmcaNoticesOrOtherLegal')}{' '}
                        <a
                          href="mailto:legal@kortix.com"
                          className="text-primary hover:underline"
                        >{tHardcodedUi.raw('appLegalPage.line1506JsxTextLegalKortixCom')}</a>
                        .
                      </p>
                      <p className="text-muted-foreground text-balance mb-4">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1511JsxTextDataPrivacyRequests')}</strong>{tHardcodedUi.raw('appLegalPage.line1511JsxTextForGdprCcpaOrOtherDataPrivacyRequests')}{' '}
                        <a
                          href="mailto:info@kortix.com"
                          className="text-primary hover:underline"
                        >{tHardcodedUi.raw('appLegalPage.line1518JsxTextInfoKortixCom')}</a>
                        {' '}{tHardcodedUi.raw('appLegalPage.line1520JsxTextWithTheSubjectLinePrivacyRequestAndInclude')}</p>
                      <p className="text-muted-foreground text-balance mb-6">
                        <strong>{tHardcodedUi.raw('appLegalPage.line1524JsxTextMailingAddress')}</strong>{tHardcodedUi.raw('appLegalPage.line1524JsxTextKortixAiCorp701TilleryStreetUnit12')}</p>
                    </div>
                  ) : (
                    <div>
                      <h2 className="text-2xl font-medium tracking-tight mb-4">{tHardcodedUi.raw('appLegalPage.line1531JsxTextPrivacyPolicy')}</h2>
                      <p className="text-sm text-muted-foreground mb-6">{tHardcodedUi.raw('appLegalPage.line1534JsxTextLastUpdated')}{LEGAL_LAST_UPDATED}
                      </p>

                      <h3 className="text-lg font-medium tracking-tight">
                        Privacy
                      </h3>
                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line1541JsxTextOurCommitmentToPrivacyAndDataProtectionIs')}</p>

                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line1551JsxTextReferencesToOurServicesAtKortixInThis')}</p>

                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line1560JsxTextKortixDoesNotCollectBiometricOrIdentifyingInformation')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line1566JsxTextInformationGathering')}</h3>
                      <p className="text-muted-foreground text-balance mb-4">{tHardcodedUi.raw('appLegalPage.line1569JsxTextWeLearnInformationAboutYouWhen')}</p>

                      <p className="font-medium mb-2">{tHardcodedUi.raw('appLegalPage.line1573JsxTextYouDirectlyProvideItToUs')}</p>
                      <p className="text-muted-foreground mb-2">{tHardcodedUi.raw('appLegalPage.line1576JsxTextForExampleWeCollect')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>{tHardcodedUi.raw('appLegalPage.line1580JsxTextNameAndContactInformationWeCollectDetailsSuch')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1584JsxTextPaymentInformationIfYouMakeAPurchaseWe')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1589JsxTextContentAndFilesWeCollectAndRetainThe')}</li>
                      </ul>

                      <p className="font-medium mb-2">{tHardcodedUi.raw('appLegalPage.line1597JsxTextWeCollectItAutomaticallyThroughOurProductsAnd')}</p>
                      <p className="text-muted-foreground mb-2">{tHardcodedUi.raw('appLegalPage.line1601JsxTextForInstanceWeCollect')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>{tHardcodedUi.raw('appLegalPage.line1605JsxTextIdentifiersAndDeviceInformationWhenYouVisitOur')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1613JsxTextGeolocationDataDependingOnYourDeviceAndApp')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1618JsxTextUsageDataWeLogYourActivityOnOur')}</li>
                      </ul>

                      <p className="font-medium mb-2">{tHardcodedUi.raw('appLegalPage.line1631JsxTextSomeoneElseTellsUsInformationAboutYou')}</p>
                      <p className="text-muted-foreground mb-2">{tHardcodedUi.raw('appLegalPage.line1634JsxTextThirdPartySourcesIncludeForExample')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>{tHardcodedUi.raw('appLegalPage.line1638JsxTextThirdPartyPartnersThirdPartyApplicationsAndServices')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1643JsxTextServiceProvidersThirdPartiesThatCollectOrProvide')}</li>
                      </ul>

                      <p className="font-medium mb-2">{tHardcodedUi.raw('appLegalPage.line1651JsxTextWhenWeTryAndUnderstandMoreAboutYou')}</p>
                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line1655JsxTextWeInferNewInformationFromOtherDataWe')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line1663JsxTextInformationUse')}</h3>
                      <p className="text-muted-foreground text-balance mb-2">{tHardcodedUi.raw('appLegalPage.line1666JsxTextWeUseEachCategoryOfPersonalInformationAbout')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-6">
                        <li>{tHardcodedUi.raw('appLegalPage.line1669JsxTextToProvideYouWithOurServices')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1670JsxTextToImproveAndDevelopOurServices')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1671JsxTextToCommunicateWithYou')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1672JsxTextToProvideCustomerSupport')}</li>
                      </ul>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line1676JsxTextInformationSharing')}</h3>
                      <p className="text-muted-foreground text-balance mb-2">{tHardcodedUi.raw('appLegalPage.line1679JsxTextWeShareInformationAboutYou')}</p>
                      <ul className="text-muted-foreground space-y-1 mb-4">
                        <li>{tHardcodedUi.raw('appLegalPage.line1683JsxTextWhenWeVeAskedReceivedYourConsentTo')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1686JsxTextAsNeededIncludingToThirdPartyServiceProviders')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1693JsxTextToComplyWithLawsOrToRespondTo')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1700JsxTextOnlyIfWeReasonablyBelieveItSNecessary')}</li>
                        <li>{tHardcodedUi.raw('appLegalPage.line1705JsxTextInTheEventOfACorporateRestructuringOr')}</li>
                      </ul>

                      <p className="text-muted-foreground text-balance mb-4">{tHardcodedUi.raw('appLegalPage.line1712JsxTextPleaseNoteThatSomeOfOurServicesInclude')}</p>

                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line1721JsxTextFinallyWeMayShareNonPersonalInformationIn')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line1726JsxTextInformationProtection')}</h3>
                      <p className="text-muted-foreground text-balance mb-6">{tHardcodedUi.raw('appLegalPage.line1729JsxTextWeImplementPhysicalBusinessAndTechnicalSecurityMeasures')}</p>

                      <h3 className="text-lg font-medium tracking-tight">{tHardcodedUi.raw('appLegalPage.line1739JsxTextContactUs')}</h3>
                      <p className="text-muted-foreground text-balance">{tHardcodedUi.raw('appLegalPage.line1742JsxTextYouCanGetInTouchByEmailingUs')}{' '}
                        <a
                          href="mailto:info@kortix.com"
                          className="text-primary hover:underline"
                        >{tHardcodedUi.raw('appLegalPage.line1747JsxTextInfoKortixCom')}</a>
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
