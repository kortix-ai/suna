import Foundation

public enum JSONValue: Codable, Sendable, Equatable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try container.decode([JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public struct Account: Codable, Sendable, Equatable {
    public let accountID: String
    public let name: String
    public let slug: String?
    public let accountRole: String?
    public let isPrimaryOwner: Bool?

    enum CodingKeys: String, CodingKey {
        case accountID = "account_id", name, slug
        case accountRole = "account_role"
        case isPrimaryOwner = "is_primary_owner"
    }
}

public enum ProjectStatus: Sendable, Equatable, Codable {
    case active, archived, unknown(String)

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        switch value { case "active": self = .active; case "archived": self = .archived; default: self = .unknown(value) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self { case .active: try container.encode("active"); case .archived: try container.encode("archived"); case .unknown(let value): try container.encode(value) }
    }
}

public struct Project: Codable, Sendable, Equatable {
    public let projectID: String
    public let accountID: String
    public let name: String
    public let repoURL: String
    public let defaultBranch: String
    public let manifestPath: String
    public let status: ProjectStatus
    public let metadata: [String: JSONValue]
    public let lastOpenedAt: String?
    public let createdAt: String
    public let updatedAt: String
    public let projectRole: String?
    public let effectiveProjectRole: String?

    enum CodingKeys: String, CodingKey {
        case projectID = "project_id", accountID = "account_id", name
        case repoURL = "repo_url", defaultBranch = "default_branch", manifestPath = "manifest_path"
        case status, metadata, lastOpenedAt = "last_opened_at", createdAt = "created_at", updatedAt = "updated_at"
        case projectRole = "project_role", effectiveProjectRole = "effective_project_role"
    }
}
