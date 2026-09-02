import Foundation
import KortixTransport
import Testing

@testable import KortixSDK

actor StubTransport: KortixTransporting {
  private let response: TransportResponse
  private(set) var requests: [TransportRequest] = []

  init(json: String, statusCode: Int = 200) {
    response = TransportResponse(statusCode: statusCode, data: Data(json.utf8))
  }

  func send(_ request: TransportRequest) async throws -> TransportResponse {
    requests.append(request)
    return response
  }
}

@Test func listsAccountsAndIgnoresUnknownFields() async throws {
  let transport = StubTransport(json: #"[{"account_id":"a1","name":"Acme","future":42}]"#)
  let accounts = try await KortixClient(transport: transport).listAccounts()
  #expect(
    accounts == [
      Account(accountID: "a1", name: "Acme", slug: nil, accountRole: nil, isPrimaryOwner: nil)
    ])
  #expect(await transport.requests == [TransportRequest(path: "/accounts")])
}

@Test func filtersProjectsByAccountAndPreservesUnknownStatus() async throws {
  let json =
    #"[{"project_id":"p1","account_id":"a1","name":"App","repo_url":"https://example.com/repo","default_branch":"main","manifest_path":"kortix.toml","status":"paused","metadata":{"generation":2},"last_opened_at":null,"created_at":"now","updated_at":"now"}]"#
  let transport = StubTransport(json: json)
  let projects = try await KortixClient(transport: transport).listProjects(accountID: "a&b")
  #expect(projects.first?.status == .unknown("paused"))
  #expect(projects.first?.metadata["generation"] == .integer(2))
  #expect(await transport.requests.first?.query == [URLQueryItem(name: "account_id", value: "a&b")])
}

@Test func decodesAndRoundTripsForwardCompatibleAccountAndProjectShapes() throws {
  let accountSource = Data(
    #"{"account_id":"a1","name":"Acme","slug":"acme","account_role":"owner","is_primary_owner":true,"branding":{"app_name":"Acme Cloud","logo_url":"https://cdn.example/logo.svg","icon_url":"https://cdn.example/icon.png","favicon_url":"https://cdn.example/favicon.ico","logo_dark_url":"https://cdn.example/logo-dark.svg","icon_dark_url":"https://cdn.example/icon-dark.png","favicon_dark_url":"https://cdn.example/favicon-dark.ico"}}"#
      .utf8)
  let account = try JSONDecoder().decode(Account.self, from: accountSource)
  #expect(account.branding?.appName == "Acme Cloud")
  #expect(try JSONDecoder().decode(Account.self, from: JSONEncoder().encode(account)) == account)

  let projectSource = Data(
    #"{"project_id":"p1","account_id":"a1","name":"App","repo_url":"https://github.com/acme/app","git_origin_url":"https://api.kortix.com/v1/git/p1.git","default_branch":"main","manifest_path":"kortix.toml","status":"active","metadata":{"generation":2},"icon":null,"icon_glyph":{"name":"Rocket","color":"blue"},"last_opened_at":"2026-01-01T00:00:00.000Z","created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-02T00:00:00.000Z","project_role":"manager","effective_project_role":"manager","dashboard_url":"https://app.kortix.com/projects/p1","experimental":{"agent_tunnel":true,"future_flag":false},"experimental_features":[{"key":"agent_tunnel","name":"Agent tunnel","description":"Connect to agents.","stability":"beta","available":true,"enabled":true,"overridden":false},{"key":"future_flag","name":"Future flag","description":"A future server feature.","stability":"future","available":false,"enabled":false,"overridden":true}],"warm_pool":{"enabled":true,"size":3},"warm_pool_available":true,"default_sandbox_provider":"future-provider","available_sandbox_providers":["daytona","future-provider"]}"#
      .utf8)
  let project = try JSONDecoder().decode(Project.self, from: projectSource)

  #expect(project.gitOriginURL == "https://api.kortix.com/v1/git/p1.git")
  #expect(project.dashboardURL == "https://app.kortix.com/projects/p1")
  #expect(project.experimental?["future_flag"] == false)
  #expect(project.experimentalFeatures?[1].key == "future_flag")
  #expect(project.experimentalFeatures?[1].stability == .unknown("future"))
  #expect(project.warmPool == ProjectWarmPool(enabled: true, size: 3))
  #expect(project.warmPoolAvailable == true)
  #expect(project.defaultSandboxProvider == .unknown("future-provider"))
  #expect(project.availableSandboxProviders == [.daytona, .unknown("future-provider")])
  #expect(project.icon == nil)
  #expect(project.iconGlyph == ProjectGlyph(name: "Rocket", color: "blue"))
  #expect(try JSONDecoder().decode(Project.self, from: JSONEncoder().encode(project)) == project)
}

@Test func decodesCurrentProjectSerializerShape() throws {
  let source = Data(
    #"{"project_id":"p1","account_id":"a1","name":"App","repo_url":"https://github.com/acme/app","git_origin_url":"https://api.kortix.com/v1/git/p1.git","default_branch":"main","manifest_path":"kortix.toml","status":"active","metadata":{},"icon":"🚀","icon_glyph":null,"last_opened_at":null,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-02T00:00:00.000Z","project_role":null,"effective_project_role":"member","dashboard_url":"https://app.kortix.com/projects/p1","experimental":{"agent_tunnel":true,"marketplace":false,"connectors_api_discover":false,"agentmail_email":false,"teams":false,"llm_gateway":false,"review_center":false,"meta_agent":false,"apps":false,"monitors":false,"warm_sessions":false,"secrets_egress":false,"pi_worker":false},"experimental_features":[{"key":"agent_tunnel","name":"Agent tunnel","description":"Connect to agents.","stability":"beta","available":true,"enabled":true,"overridden":false}],"default_sandbox_provider":"daytona","available_sandbox_providers":["daytona","platinum","e2b"]}"#
      .utf8)
  let project = try JSONDecoder().decode(Project.self, from: source)

  #expect(project.gitOriginURL == "https://api.kortix.com/v1/git/p1.git")
  #expect(project.experimental?["agent_tunnel"] == true)
  #expect(project.experimentalFeatures?.first?.stability == .beta)
  #expect(project.defaultSandboxProvider == .daytona)
  #expect(project.availableSandboxProviders == [.daytona, .platinum, .e2b])
  #expect(project.warmPool == nil)
  #expect(project.warmPoolAvailable == nil)
}

@Test func olderProjectShapesDefaultNewFieldsToNil() throws {
  let source = Data(
    #"{"project_id":"p1","account_id":"a1","name":"App","repo_url":"https://example.com/repo","default_branch":"main","manifest_path":"kortix.toml","status":"active","metadata":{},"last_opened_at":null,"created_at":"now","updated_at":"now"}"#
      .utf8)
  let project = try JSONDecoder().decode(Project.self, from: source)

  #expect(project.gitOriginURL == nil)
  #expect(project.dashboardURL == nil)
  #expect(project.experimental == nil)
  #expect(project.experimentalFeatures == nil)
  #expect(project.warmPool == nil)
  #expect(project.warmPoolAvailable == nil)
  #expect(project.defaultSandboxProvider == nil)
  #expect(project.availableSandboxProviders == nil)
  #expect(project.icon == nil)
  #expect(project.iconGlyph == nil)
}

@Test func rejectsUnsafeProjectIdentifierBeforeTransport() async throws {
  let transport = StubTransport(json: "{}")
  await #expect(throws: KortixTransportError.invalidPath("../secret")) {
    try await KortixClient(transport: transport).getProject("../secret")
  }
  #expect(await transport.requests.isEmpty)
}

@Test func getsAccountDetailWireModel() async throws {
  let json =
    #"{"account_id":"a1","name":"Acme","member_count":3,"project_count":7,"role":"owner","mfa_required":true,"branding":null,"created_at":"2026-01-01","updated_at":"2026-01-02"}"#
  let transport = StubTransport(json: json)
  let detail = try await KortixClient(transport: transport).getAccount("a1")

  #expect(
    detail
      == AccountDetail(
        accountID: "a1",
        name: "Acme",
        memberCount: 3,
        projectCount: 7,
        role: "owner",
        mfaRequired: true,
        branding: nil,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-02"
      ))
  #expect(await transport.requests == [TransportRequest(path: "/accounts/a1")])
}

@Test func publicDTOInitializersExposeAllFields() {
  let branding = AccountBranding(
    appName: "Acme",
    logoURL: nil,
    iconURL: nil,
    faviconURL: nil,
    logoDarkURL: nil,
    iconDarkURL: nil,
    faviconDarkURL: nil
  )
  let account = Account(
    accountID: "a1", name: "Acme", slug: "acme", accountRole: "owner", isPrimaryOwner: true)
  let project = Project(
    projectID: "p1", accountID: "a1", name: "App", repoURL: "https://example.com/repo",
    defaultBranch: "main", manifestPath: "kortix.toml", status: .active, metadata: [:],
    lastOpenedAt: nil, createdAt: "now", updatedAt: "now", projectRole: "admin",
    effectiveProjectRole: "admin"
  )
  #expect(account.slug == "acme")
  #expect(project.projectRole == "admin")
  #expect(branding.appName == "Acme")
}

@Test func preservesJSONNumberCategoriesAndPrecision() throws {
  let source = Data(
    #"{"min":-9223372036854775808,"max":9223372036854775807,"unsigned":18446744073709551615,"unsafe":9007199254740993,"negative":-17,"fraction":1234567890.123456789,"exponent":1.25e3,"nested":[null,{"value":7}]}"#
      .utf8)
  let decoded = try JSONDecoder().decode([String: JSONValue].self, from: source)

  #expect(decoded["min"] == .integer(Int64.min))
  #expect(decoded["max"] == .integer(Int64.max))
  #expect(decoded["unsigned"] == .unsignedInteger(UInt64.max))
  #expect(decoded["unsafe"] == .integer(9_007_199_254_740_993))
  #expect(decoded["negative"] == .integer(-17))
  #expect(decoded["fraction"] == .decimal(Decimal(string: "1234567890.123456789")!))
  #expect(decoded["exponent"] == .integer(1_250))
  #expect(decoded["nested"] == .array([.null, .object(["value": .integer(7)])]))

  let encoded = try JSONEncoder().encode(decoded)
  let roundTrip = try JSONDecoder().decode([String: JSONValue].self, from: encoded)
  #expect(roundTrip == decoded)
}
