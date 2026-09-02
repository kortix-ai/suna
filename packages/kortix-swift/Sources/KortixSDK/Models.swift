import Foundation

public enum JSONValue: Codable, Sendable, Equatable {
  case string(String)
  case integer(Int64)
  case unsignedInteger(UInt64)
  case decimal(Decimal)
  case bool(Bool)
  case object([String: JSONValue])
  case array([JSONValue])
  case null

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Int64.self) {
      self = .integer(value)
    } else if let value = try? container.decode(UInt64.self) {
      self = .unsignedInteger(value)
    } else if let value = try? container.decode(Decimal.self) {
      self = .decimal(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([String: JSONValue].self) {
      self = .object(value)
    } else {
      self = .array(try container.decode([JSONValue].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let value): try container.encode(value)
    case .integer(let value): try container.encode(value)
    case .unsignedInteger(let value): try container.encode(value)
    case .decimal(let value): try container.encode(value)
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
  public let branding: AccountBranding?

  public init(
    accountID: String,
    name: String,
    slug: String? = nil,
    accountRole: String? = nil,
    isPrimaryOwner: Bool? = nil,
    branding: AccountBranding? = nil
  ) {
    self.accountID = accountID
    self.name = name
    self.slug = slug
    self.accountRole = accountRole
    self.isPrimaryOwner = isPrimaryOwner
    self.branding = branding
  }

  enum CodingKeys: String, CodingKey {
    case accountID = "account_id"
    case name, slug
    case accountRole = "account_role"
    case isPrimaryOwner = "is_primary_owner"
    case branding
  }
}

public struct AccountBranding: Codable, Sendable, Equatable {
  public let appName: String?
  public let logoURL: String?
  public let iconURL: String?
  public let faviconURL: String?
  public let logoDarkURL: String?
  public let iconDarkURL: String?
  public let faviconDarkURL: String?

  public init(
    appName: String? = nil,
    logoURL: String? = nil,
    iconURL: String? = nil,
    faviconURL: String? = nil,
    logoDarkURL: String? = nil,
    iconDarkURL: String? = nil,
    faviconDarkURL: String? = nil
  ) {
    self.appName = appName
    self.logoURL = logoURL
    self.iconURL = iconURL
    self.faviconURL = faviconURL
    self.logoDarkURL = logoDarkURL
    self.iconDarkURL = iconDarkURL
    self.faviconDarkURL = faviconDarkURL
  }

  enum CodingKeys: String, CodingKey {
    case appName = "app_name"
    case logoURL = "logo_url"
    case iconURL = "icon_url"
    case faviconURL = "favicon_url"
    case logoDarkURL = "logo_dark_url"
    case iconDarkURL = "icon_dark_url"
    case faviconDarkURL = "favicon_dark_url"
  }
}

public struct AccountDetail: Codable, Sendable, Equatable {
  public let accountID: String
  public let name: String
  public let memberCount: Int
  public let projectCount: Int
  public let role: String
  public let mfaRequired: Bool?
  public let branding: AccountBranding?
  public let createdAt: String
  public let updatedAt: String

  public init(
    accountID: String,
    name: String,
    memberCount: Int,
    projectCount: Int,
    role: String,
    mfaRequired: Bool? = nil,
    branding: AccountBranding? = nil,
    createdAt: String,
    updatedAt: String
  ) {
    self.accountID = accountID
    self.name = name
    self.memberCount = memberCount
    self.projectCount = projectCount
    self.role = role
    self.mfaRequired = mfaRequired
    self.branding = branding
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }

  enum CodingKeys: String, CodingKey {
    case accountID = "account_id"
    case name
    case memberCount = "member_count"
    case projectCount = "project_count"
    case role
    case mfaRequired = "mfa_required"
    case branding
    case createdAt = "created_at"
    case updatedAt = "updated_at"
  }
}

public enum ProjectStatus: Sendable, Equatable, Codable {
  case active, archived
  case unknown(String)

  public init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer().decode(String.self)
    switch value {
    case "active": self = .active
    case "archived": self = .archived
    default: self = .unknown(value)
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .active: try container.encode("active")
    case .archived: try container.encode("archived")
    case .unknown(let value): try container.encode(value)
    }
  }
}

public enum FeatureFlagStability: Codable, Sendable, Equatable {
  case experimental
  case beta
  case stable
  case unknown(String)

  public init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer().decode(String.self)
    switch value {
    case "experimental": self = .experimental
    case "beta": self = .beta
    case "stable": self = .stable
    default: self = .unknown(value)
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .experimental: try container.encode("experimental")
    case .beta: try container.encode("beta")
    case .stable: try container.encode("stable")
    case .unknown(let value): try container.encode(value)
    }
  }
}

public struct FeatureFlagView: Codable, Sendable, Equatable {
  public let key: String
  public let name: String
  public let description: String
  public let stability: FeatureFlagStability
  public let available: Bool
  public let enabled: Bool
  public let overridden: Bool

  public init(
    key: String,
    name: String,
    description: String,
    stability: FeatureFlagStability,
    available: Bool,
    enabled: Bool,
    overridden: Bool
  ) {
    self.key = key
    self.name = name
    self.description = description
    self.stability = stability
    self.available = available
    self.enabled = enabled
    self.overridden = overridden
  }
}

public struct ProjectWarmPool: Codable, Sendable, Equatable {
  public let enabled: Bool
  public let size: Int

  public init(enabled: Bool, size: Int) {
    self.enabled = enabled
    self.size = size
  }
}

public enum SandboxProvider: Codable, Sendable, Equatable {
  case daytona
  case platinum
  case e2b
  case unknown(String)

  public init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer().decode(String.self)
    switch value {
    case "daytona": self = .daytona
    case "platinum": self = .platinum
    case "e2b": self = .e2b
    default: self = .unknown(value)
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .daytona: try container.encode("daytona")
    case .platinum: try container.encode("platinum")
    case .e2b: try container.encode("e2b")
    case .unknown(let value): try container.encode(value)
    }
  }
}

public struct ProjectGlyph: Codable, Sendable, Equatable {
  public let name: String
  public let color: String

  public init(name: String, color: String) {
    self.name = name
    self.color = color
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
  public let gitOriginURL: String?
  public let dashboardURL: String?
  public let experimental: [String: Bool]?
  public let experimentalFeatures: [FeatureFlagView]?
  public let warmPool: ProjectWarmPool?
  public let warmPoolAvailable: Bool?
  public let defaultSandboxProvider: SandboxProvider?
  public let availableSandboxProviders: [SandboxProvider]?
  public let icon: String?
  public let iconGlyph: ProjectGlyph?

  public init(
    projectID: String,
    accountID: String,
    name: String,
    repoURL: String,
    defaultBranch: String,
    manifestPath: String,
    status: ProjectStatus,
    metadata: [String: JSONValue],
    lastOpenedAt: String?,
    createdAt: String,
    updatedAt: String,
    projectRole: String? = nil,
    effectiveProjectRole: String? = nil,
    gitOriginURL: String? = nil,
    dashboardURL: String? = nil,
    experimental: [String: Bool]? = nil,
    experimentalFeatures: [FeatureFlagView]? = nil,
    warmPool: ProjectWarmPool? = nil,
    warmPoolAvailable: Bool? = nil,
    defaultSandboxProvider: SandboxProvider? = nil,
    availableSandboxProviders: [SandboxProvider]? = nil,
    icon: String? = nil,
    iconGlyph: ProjectGlyph? = nil
  ) {
    self.projectID = projectID
    self.accountID = accountID
    self.name = name
    self.repoURL = repoURL
    self.defaultBranch = defaultBranch
    self.manifestPath = manifestPath
    self.status = status
    self.metadata = metadata
    self.lastOpenedAt = lastOpenedAt
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.projectRole = projectRole
    self.effectiveProjectRole = effectiveProjectRole
    self.gitOriginURL = gitOriginURL
    self.dashboardURL = dashboardURL
    self.experimental = experimental
    self.experimentalFeatures = experimentalFeatures
    self.warmPool = warmPool
    self.warmPoolAvailable = warmPoolAvailable
    self.defaultSandboxProvider = defaultSandboxProvider
    self.availableSandboxProviders = availableSandboxProviders
    self.icon = icon
    self.iconGlyph = iconGlyph
  }

  enum CodingKeys: String, CodingKey {
    case projectID = "project_id"
    case accountID = "account_id"
    case name
    case repoURL = "repo_url"
    case gitOriginURL = "git_origin_url"
    case defaultBranch = "default_branch"
    case manifestPath = "manifest_path"
    case status, metadata, icon
    case iconGlyph = "icon_glyph"
    case lastOpenedAt = "last_opened_at"
    case createdAt = "created_at"
    case updatedAt = "updated_at"
    case projectRole = "project_role"
    case effectiveProjectRole = "effective_project_role"
    case dashboardURL = "dashboard_url"
    case experimental
    case experimentalFeatures = "experimental_features"
    case warmPool = "warm_pool"
    case warmPoolAvailable = "warm_pool_available"
    case defaultSandboxProvider = "default_sandbox_provider"
    case availableSandboxProviders = "available_sandbox_providers"
  }
}
