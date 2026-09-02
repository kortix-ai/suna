import KortixSDK
import Testing

@Test func dtoInitializersArePublicToExternalConsumers() {
  let branding = AccountBranding(appName: "Acme")
  let account = Account(accountID: "a1", name: "Acme", branding: branding)
  let project = Project(
    projectID: "p1",
    accountID: "a1",
    name: "App",
    repoURL: "https://example.com/repo",
    defaultBranch: "main",
    manifestPath: "kortix.toml",
    status: .active,
    metadata: [:],
    lastOpenedAt: nil,
    createdAt: "now",
    updatedAt: "now",
    gitOriginURL: "https://api.kortix.com/v1/git/p1.git",
    dashboardURL: "https://app.kortix.com/projects/p1",
    experimental: ["agent_tunnel": true],
    experimentalFeatures: [
      FeatureFlagView(
        key: "agent_tunnel", name: "Agent tunnel", description: "Connect.", stability: .beta,
        available: true, enabled: true, overridden: false)
    ],
    warmPool: ProjectWarmPool(enabled: true, size: 2),
    warmPoolAvailable: true,
    defaultSandboxProvider: .daytona,
    availableSandboxProviders: [.daytona],
    icon: nil,
    iconGlyph: ProjectGlyph(name: "Rocket", color: "blue")
  )

  #expect(account.accountID == "a1")
  #expect(account.branding == branding)
  #expect(project.projectID == "p1")
  #expect(project.warmPool?.size == 2)
}
