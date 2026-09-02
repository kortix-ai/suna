import Foundation
import Testing
@testable import KortixSDK
import KortixTransport

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
    #expect(accounts == [Account(accountID: "a1", name: "Acme", slug: nil, accountRole: nil, isPrimaryOwner: nil)])
    #expect(await transport.requests == [TransportRequest(path: "/accounts")])
}

@Test func filtersProjectsByAccountAndPreservesUnknownStatus() async throws {
    let json = #"[{"project_id":"p1","account_id":"a1","name":"App","repo_url":"https://example.com/repo","default_branch":"main","manifest_path":"kortix.toml","status":"paused","metadata":{"generation":2},"last_opened_at":null,"created_at":"now","updated_at":"now"}]"#
    let transport = StubTransport(json: json)
    let projects = try await KortixClient(transport: transport).listProjects(accountID: "a&b")
    #expect(projects.first?.status == .unknown("paused"))
    #expect(projects.first?.metadata["generation"] == .number(2))
    #expect(await transport.requests.first?.query == [URLQueryItem(name: "account_id", value: "a&b")])
}

@Test func rejectsUnsafeProjectIdentifierBeforeTransport() async throws {
    let transport = StubTransport(json: "{}")
    await #expect(throws: KortixTransportError.invalidPath("../secret")) {
        try await KortixClient(transport: transport).getProject("../secret")
    }
    #expect(await transport.requests.isEmpty)
}
