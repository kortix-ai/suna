/* eslint-disable */
/**
 * Generated data model types.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  DocumentByName,
  TableNamesInDataModel,
  SystemTableNames,
  AnyDataModel,
} from "convex/server";
import type { GenericId } from "convex/values";

/**
 * A type describing your Convex data model.
 *
 * This type includes information about what tables you have, the type of
 * documents stored in those tables, and the indexes defined on them.
 *
 * This type is used to parameterize methods like `queryGeneric` and
 * `mutationGeneric` to make them type-safe.
 */

export type DataModel = {
  account: {
    document: {
      accessToken?: null | string;
      accessTokenExpiresAt?: null | number;
      accountId: string;
      createdAt: number;
      idToken?: null | string;
      issuer: string;
      password?: null | string;
      providerId: string;
      refreshToken?: null | string;
      refreshTokenExpiresAt?: null | number;
      scope?: null | string;
      updatedAt: number;
      userId: string;
      _id: Id<"account">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "accessToken"
      | "accessTokenExpiresAt"
      | "accountId"
      | "createdAt"
      | "idToken"
      | "issuer"
      | "password"
      | "providerId"
      | "refreshToken"
      | "refreshTokenExpiresAt"
      | "scope"
      | "updatedAt"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      accountId: ["accountId", "_creationTime"];
      accountId_providerId: ["accountId", "providerId", "_creationTime"];
      issuer_accountId: ["issuer", "accountId", "_creationTime"];
      providerId_userId: ["providerId", "userId", "_creationTime"];
      userId: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  aggregate_bucket: {
    document: {
      count: number;
      indexName: string;
      keyHash: string;
      keyParts: Array<null | any>;
      nonNullCountValues: Record<string, number>;
      sumValues: Record<string, number>;
      tableKey: string;
      updatedAt: number;
      _id: Id<"aggregate_bucket">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "count"
      | "indexName"
      | "keyHash"
      | "keyParts"
      | "nonNullCountValues"
      | `nonNullCountValues.${string}`
      | "sumValues"
      | `sumValues.${string}`
      | "tableKey"
      | "updatedAt";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_table_index: ["tableKey", "indexName", "_creationTime"];
      by_table_index_hash: [
        "tableKey",
        "indexName",
        "keyHash",
        "_creationTime",
      ];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  aggregate_extrema: {
    document: {
      count: number;
      fieldName: string;
      indexName: string;
      keyHash: string;
      sortKey: string;
      tableKey: string;
      updatedAt: number;
      value: any;
      valueHash: string;
      _id: Id<"aggregate_extrema">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "count"
      | "fieldName"
      | "indexName"
      | "keyHash"
      | "sortKey"
      | "tableKey"
      | "updatedAt"
      | "value"
      | "valueHash";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_table_index: ["tableKey", "indexName", "_creationTime"];
      by_table_index_hash_field_sort: [
        "tableKey",
        "indexName",
        "keyHash",
        "fieldName",
        "sortKey",
        "_creationTime",
      ];
      by_table_index_hash_field_value: [
        "tableKey",
        "indexName",
        "keyHash",
        "fieldName",
        "valueHash",
        "_creationTime",
      ];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  aggregate_member: {
    document: {
      docId: string;
      extremaValues: Record<string, null | any>;
      indexName: string;
      keyHash: string;
      keyParts: Array<null | any>;
      kind: string;
      nonNullCountValues: Record<string, number>;
      rankKey?: null | any;
      rankNamespace?: null | any;
      rankSumValue?: null | number;
      sumValues: Record<string, number>;
      tableKey: string;
      updatedAt: number;
      _id: Id<"aggregate_member">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "docId"
      | "extremaValues"
      | `extremaValues.${string}`
      | "indexName"
      | "keyHash"
      | "keyParts"
      | "kind"
      | "nonNullCountValues"
      | `nonNullCountValues.${string}`
      | "rankKey"
      | "rankNamespace"
      | "rankSumValue"
      | "sumValues"
      | `sumValues.${string}`
      | "tableKey"
      | "updatedAt";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_kind_table_index: ["kind", "tableKey", "indexName", "_creationTime"];
      by_kind_table_index_doc: [
        "kind",
        "tableKey",
        "indexName",
        "docId",
        "_creationTime",
      ];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  aggregate_rank_node: {
    document: {
      aggregate?: null | { count: number; sum: number };
      items: Array<{ k: any; s: number; v: any }>;
      subtrees: Array<string>;
      _id: Id<"aggregate_rank_node">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "aggregate"
      | "aggregate.count"
      | "aggregate.sum"
      | "items"
      | "subtrees";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  aggregate_rank_tree: {
    document: {
      aggregateName: string;
      deletionStack?: null | Array<Id<"aggregate_rank_node">>;
      maxNodeSize: number;
      namespace?: null | any;
      root: Id<"aggregate_rank_node">;
      _id: Id<"aggregate_rank_tree">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "aggregateName"
      | "deletionStack"
      | "maxNodeSize"
      | "namespace"
      | "root";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_aggregate_name: ["aggregateName", "_creationTime"];
      by_namespace: ["namespace", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  aggregate_state: {
    document: {
      completedAt?: null | number;
      cursor?: null | string;
      indexName: string;
      keyDefinitionHash: string;
      kind: string;
      lastError?: null | string;
      metricDefinitionHash: string;
      processed: number;
      startedAt: number;
      status: string;
      tableKey: string;
      updatedAt: number;
      _id: Id<"aggregate_state">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "completedAt"
      | "cursor"
      | "indexName"
      | "keyDefinitionHash"
      | "kind"
      | "lastError"
      | "metricDefinitionHash"
      | "processed"
      | "startedAt"
      | "status"
      | "tableKey"
      | "updatedAt";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_kind_status: ["kind", "status", "_creationTime"];
      by_kind_table_index: ["kind", "tableKey", "indexName", "_creationTime"];
      by_table_status: ["tableKey", "status", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  apikey: {
    document: {
      configId: string;
      createdAt: number;
      enabled?: null | boolean;
      expiresAt?: null | number;
      key: string;
      lastRefillAt?: null | number;
      lastRequest?: null | number;
      metadata?: null | string;
      name?: null | string;
      permissions?: null | string;
      prefix?: null | string;
      rateLimitEnabled?: null | boolean;
      rateLimitMax?: null | number;
      rateLimitTimeWindow?: null | number;
      referenceId: string;
      refillAmount?: null | number;
      refillInterval?: null | number;
      remaining?: null | number;
      requestCount?: null | number;
      start?: null | string;
      updatedAt: number;
      _id: Id<"apikey">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "configId"
      | "createdAt"
      | "enabled"
      | "expiresAt"
      | "key"
      | "lastRefillAt"
      | "lastRequest"
      | "metadata"
      | "name"
      | "permissions"
      | "prefix"
      | "rateLimitEnabled"
      | "rateLimitMax"
      | "rateLimitTimeWindow"
      | "referenceId"
      | "refillAmount"
      | "refillInterval"
      | "remaining"
      | "requestCount"
      | "start"
      | "updatedAt";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  deviceCode: {
    document: {
      clientId?: null | string;
      deviceCode: string;
      expiresAt: number;
      lastPolledAt?: null | number;
      pollingInterval?: null | number;
      scope?: null | string;
      status: string;
      userCode: string;
      userId?: null | string;
      _id: Id<"deviceCode">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "clientId"
      | "deviceCode"
      | "expiresAt"
      | "lastPolledAt"
      | "pollingInterval"
      | "scope"
      | "status"
      | "userCode"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      deviceCode: ["deviceCode", "_creationTime"];
      userCode: ["userCode", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  invitation: {
    document: {
      createdAt: number;
      email: string;
      expiresAt: number;
      inviterId: string;
      organizationId: string;
      role?: null | string;
      status: string;
      teamId?: null | string;
      _id: Id<"invitation">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "createdAt"
      | "email"
      | "expiresAt"
      | "inviterId"
      | "organizationId"
      | "role"
      | "status"
      | "teamId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      email: ["email", "_creationTime"];
      email_organizationId_status: [
        "email",
        "organizationId",
        "status",
        "_creationTime",
      ];
      inviterId: ["inviterId", "_creationTime"];
      organizationId: ["organizationId", "_creationTime"];
      organizationId_status: ["organizationId", "status", "_creationTime"];
      role: ["role", "_creationTime"];
      status: ["status", "_creationTime"];
      teamId: ["teamId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  jwks: {
    document: {
      alg?: null | string;
      createdAt: number;
      crv?: null | string;
      expiresAt?: null | number;
      privateKey: string;
      publicKey: string;
      _id: Id<"jwks">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "alg"
      | "createdAt"
      | "crv"
      | "expiresAt"
      | "privateKey"
      | "publicKey";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  member: {
    document: {
      createdAt: number;
      organizationId: string;
      role: string;
      userId: string;
      _id: Id<"member">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "createdAt"
      | "organizationId"
      | "role"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      organizationId: ["organizationId", "_creationTime"];
      organizationId_role: ["organizationId", "role", "_creationTime"];
      organizationId_userId: ["organizationId", "userId", "_creationTime"];
      role: ["role", "_creationTime"];
      userId: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  migration_run: {
    document: {
      allowDrift: boolean;
      cancelRequested: boolean;
      completedAt?: null | number;
      currentIndex: number;
      direction: string;
      dryRun: boolean;
      lastError?: null | string;
      migrationIds: Array<string>;
      runId: string;
      startedAt: number;
      status: string;
      updatedAt: number;
      _id: Id<"migration_run">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "allowDrift"
      | "cancelRequested"
      | "completedAt"
      | "currentIndex"
      | "direction"
      | "dryRun"
      | "lastError"
      | "migrationIds"
      | "runId"
      | "startedAt"
      | "status"
      | "updatedAt";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_run_id: ["runId", "_creationTime"];
      by_started_at: ["startedAt", "_creationTime"];
      by_status: ["status", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  migration_state: {
    document: {
      applied: boolean;
      checksum: string;
      completedAt?: null | number;
      cursor?: null | string;
      direction?: null | string;
      lastError?: null | string;
      migrationId: string;
      processed: number;
      runId?: null | string;
      startedAt?: null | number;
      status: string;
      updatedAt: number;
      writeMode: string;
      _id: Id<"migration_state">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "applied"
      | "checksum"
      | "completedAt"
      | "cursor"
      | "direction"
      | "lastError"
      | "migrationId"
      | "processed"
      | "runId"
      | "startedAt"
      | "status"
      | "updatedAt"
      | "writeMode";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_migration_id: ["migrationId", "_creationTime"];
      by_status: ["status", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  oauthAccessToken: {
    document: {
      authorizationCodeId?: null | string;
      clientId: string;
      confirmation?: null | string;
      createdAt?: null | number;
      expiresAt?: null | number;
      referenceId?: null | string;
      refreshId?: null | string;
      requestedUserInfoClaims?: null | Array<string>;
      resources?: null | Array<string>;
      revoked?: null | number;
      scopes: Array<string>;
      sessionId?: null | string;
      token?: null | string;
      userId?: null | string;
      _id: Id<"oauthAccessToken">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "authorizationCodeId"
      | "clientId"
      | "confirmation"
      | "createdAt"
      | "expiresAt"
      | "referenceId"
      | "refreshId"
      | "requestedUserInfoClaims"
      | "resources"
      | "revoked"
      | "scopes"
      | "sessionId"
      | "token"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      clientId: ["clientId", "_creationTime"];
      oauthAccessToken_token_unique: ["token", "_creationTime"];
      refreshId: ["refreshId", "_creationTime"];
      sessionId: ["sessionId", "_creationTime"];
      userId: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  oauthClient: {
    document: {
      applicationType?: null | string;
      backchannelLogoutSessionRequired?: null | boolean;
      backchannelLogoutUri?: null | string;
      clientCredentialsScopes?: null | Array<string>;
      clientDiscoveryId?: null | string;
      clientId: string;
      clientSecret?: null | string;
      contacts?: null | Array<string>;
      createdAt?: null | number;
      disabled?: null | boolean;
      dpopBoundAccessTokens?: null | boolean;
      enableEndSession?: null | boolean;
      grantTypes?: null | Array<string>;
      icon?: null | string;
      jwks?: null | string;
      jwksUri?: null | string;
      metadata?: null | string;
      name?: null | string;
      policy?: null | string;
      postLogoutRedirectUris?: null | Array<string>;
      redirectUris: Array<string>;
      referenceId?: null | string;
      requirePKCE?: null | boolean;
      responseTypes?: null | Array<string>;
      scopes?: null | Array<string>;
      skipConsent?: null | boolean;
      softwareId?: null | string;
      softwareStatement?: null | string;
      softwareVersion?: null | string;
      subjectType?: null | string;
      tokenEndpointAuthMethod?: null | string;
      tos?: null | string;
      updatedAt?: null | number;
      uri?: null | string;
      userId?: null | string;
      _id: Id<"oauthClient">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "applicationType"
      | "backchannelLogoutSessionRequired"
      | "backchannelLogoutUri"
      | "clientCredentialsScopes"
      | "clientDiscoveryId"
      | "clientId"
      | "clientSecret"
      | "contacts"
      | "createdAt"
      | "disabled"
      | "dpopBoundAccessTokens"
      | "enableEndSession"
      | "grantTypes"
      | "icon"
      | "jwks"
      | "jwksUri"
      | "metadata"
      | "name"
      | "policy"
      | "postLogoutRedirectUris"
      | "redirectUris"
      | "referenceId"
      | "requirePKCE"
      | "responseTypes"
      | "scopes"
      | "skipConsent"
      | "softwareId"
      | "softwareStatement"
      | "softwareVersion"
      | "subjectType"
      | "tokenEndpointAuthMethod"
      | "tos"
      | "updatedAt"
      | "uri"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      oauthClient_clientId_unique: ["clientId", "_creationTime"];
      userId: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  oauthClientAssertion: {
    document: {
      expiresAt: number;
      _id: Id<"oauthClientAssertion">;
      _creationTime: number;
    };
    fieldPaths: "_creationTime" | "_id" | "expiresAt";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  oauthClientResource: {
    document: {
      clientId: string;
      createdAt?: null | number;
      metadata?: null | string;
      resourceId: string;
      _id: Id<"oauthClientResource">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "clientId"
      | "createdAt"
      | "metadata"
      | "resourceId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      clientId_resourceId: ["clientId", "resourceId", "_creationTime"];
      resourceId: ["resourceId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  oauthConsent: {
    document: {
      clientId: string;
      createdAt?: null | number;
      referenceId?: null | string;
      requestedUserInfoClaims?: null | Array<string>;
      resources?: null | Array<string>;
      scopes: Array<string>;
      updatedAt?: null | number;
      userId?: null | string;
      _id: Id<"oauthConsent">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "clientId"
      | "createdAt"
      | "referenceId"
      | "requestedUserInfoClaims"
      | "resources"
      | "scopes"
      | "updatedAt"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      clientId_userId: ["clientId", "userId", "_creationTime"];
      userId: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  oauthRefreshToken: {
    document: {
      authTime?: null | number;
      authorizationCodeId?: null | string;
      clientId: string;
      confirmation?: null | string;
      createdAt?: null | number;
      expiresAt?: null | number;
      referenceId?: null | string;
      requestedUserInfoClaims?: null | Array<string>;
      resources?: null | Array<string>;
      revoked?: null | number;
      rotatedAt?: null | number;
      rotationReplayExpiresAt?: null | number;
      rotationReplayResponse?: null | string;
      scopes: Array<string>;
      sessionId?: null | string;
      token: string;
      userId: string;
      _id: Id<"oauthRefreshToken">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "authorizationCodeId"
      | "authTime"
      | "clientId"
      | "confirmation"
      | "createdAt"
      | "expiresAt"
      | "referenceId"
      | "requestedUserInfoClaims"
      | "resources"
      | "revoked"
      | "rotatedAt"
      | "rotationReplayExpiresAt"
      | "rotationReplayResponse"
      | "scopes"
      | "sessionId"
      | "token"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      clientId: ["clientId", "_creationTime"];
      oauthRefreshToken_token_unique: ["token", "_creationTime"];
      sessionId: ["sessionId", "_creationTime"];
      userId: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  oauthResource: {
    document: {
      accessTokenTtl?: null | number;
      allowedScopes?: null | Array<string>;
      createdAt?: null | number;
      customClaims?: null | string;
      disabled?: null | boolean;
      dpopBoundAccessTokensRequired?: null | boolean;
      identifier: string;
      metadata?: null | string;
      name: string;
      policyVersion?: null | number;
      refreshTokenTtl?: null | number;
      signingAlgorithm?: null | string;
      signingKeyId?: null | string;
      updatedAt?: null | number;
      _id: Id<"oauthResource">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "accessTokenTtl"
      | "allowedScopes"
      | "createdAt"
      | "customClaims"
      | "disabled"
      | "dpopBoundAccessTokensRequired"
      | "identifier"
      | "metadata"
      | "name"
      | "policyVersion"
      | "refreshTokenTtl"
      | "signingAlgorithm"
      | "signingKeyId"
      | "updatedAt";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      oauthResource_identifier_unique: ["identifier", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  organization: {
    document: {
      createdAt: number;
      logo?: null | string;
      metadata?: null | string;
      name: string;
      slug: string;
      _id: Id<"organization">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "createdAt"
      | "logo"
      | "metadata"
      | "name"
      | "slug";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      name: ["name", "_creationTime"];
      organization_slug_unique: ["slug", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  organizationRole: {
    document: {
      createdAt: number;
      organizationId: string;
      permission: string;
      role: string;
      updatedAt?: null | number;
      _id: Id<"organizationRole">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "createdAt"
      | "organizationId"
      | "permission"
      | "role"
      | "updatedAt";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      organizationId: ["organizationId", "_creationTime"];
      organizationId_role: ["organizationId", "role", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  passkey: {
    document: {
      aaguid?: null | string;
      backedUp: boolean;
      counter: number;
      createdAt?: null | number;
      credentialID: string;
      deviceType: string;
      name?: null | string;
      publicKey: string;
      transports?: null | string;
      userId: string;
      _id: Id<"passkey">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "aaguid"
      | "backedUp"
      | "counter"
      | "createdAt"
      | "credentialID"
      | "deviceType"
      | "name"
      | "publicKey"
      | "transports"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      credentialID: ["credentialID", "_creationTime"];
      userId: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  session: {
    document: {
      activeOrganizationId?: null | string;
      activeTeamId?: null | string;
      createdAt: number;
      expiresAt: number;
      impersonatedBy?: null | string;
      ipAddress?: null | string;
      token: string;
      updatedAt: number;
      userAgent?: null | string;
      userId: string;
      _id: Id<"session">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "activeOrganizationId"
      | "activeTeamId"
      | "createdAt"
      | "expiresAt"
      | "impersonatedBy"
      | "ipAddress"
      | "token"
      | "updatedAt"
      | "userAgent"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      activeOrganizationId: ["activeOrganizationId", "_creationTime"];
      activeTeamId: ["activeTeamId", "_creationTime"];
      expiresAt: ["expiresAt", "_creationTime"];
      expiresAt_userId: ["expiresAt", "userId", "_creationTime"];
      session_token_unique: ["token", "_creationTime"];
      userId: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  team: {
    document: {
      createdAt: number;
      memberCount: number;
      name: string;
      organizationId: string;
      updatedAt?: null | number;
      _id: Id<"team">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "createdAt"
      | "memberCount"
      | "name"
      | "organizationId"
      | "updatedAt";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      organizationId: ["organizationId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  teamMember: {
    document: {
      createdAt?: null | number;
      membershipKey?: null | string;
      teamId: string;
      userId: string;
      _id: Id<"teamMember">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "createdAt"
      | "membershipKey"
      | "teamId"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      teamId: ["teamId", "_creationTime"];
      teamId_userId: ["teamId", "userId", "_creationTime"];
      teamMember_membershipKey_unique: ["membershipKey", "_creationTime"];
      userId: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  twoFactor: {
    document: {
      backupCodes: string;
      failedVerificationCount?: null | number;
      lockedUntil?: null | number;
      secret: string;
      userId: string;
      verified?: null | boolean;
      _id: Id<"twoFactor">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "backupCodes"
      | "failedVerificationCount"
      | "lockedUntil"
      | "secret"
      | "userId"
      | "verified";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      userId: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  user: {
    document: {
      banExpires?: null | number;
      banReason?: null | string;
      banned?: null | boolean;
      createdAt: number;
      displayUsername?: null | string;
      email: string;
      emailVerified: boolean;
      image?: null | string;
      isAnonymous?: null | boolean;
      lastActiveOrganizationId?: null | string;
      name: string;
      personalOrganizationId?: null | string;
      phoneNumber?: null | string;
      phoneNumberVerified?: null | boolean;
      role?: null | string;
      twoFactorEnabled?: null | boolean;
      updatedAt: number;
      userId?: null | string;
      username?: null | string;
      _id: Id<"user">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "banExpires"
      | "banned"
      | "banReason"
      | "createdAt"
      | "displayUsername"
      | "email"
      | "emailVerified"
      | "image"
      | "isAnonymous"
      | "lastActiveOrganizationId"
      | "name"
      | "personalOrganizationId"
      | "phoneNumber"
      | "phoneNumberVerified"
      | "role"
      | "twoFactorEnabled"
      | "updatedAt"
      | "userId"
      | "username";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      email_name: ["email", "name", "_creationTime"];
      lastActiveOrganizationId: ["lastActiveOrganizationId", "_creationTime"];
      name: ["name", "_creationTime"];
      personalOrganizationId: ["personalOrganizationId", "_creationTime"];
      user_email_unique: ["email", "_creationTime"];
      user_phoneNumber_unique: ["phoneNumber", "_creationTime"];
      user_username_unique: ["username", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  verification: {
    document: {
      createdAt: number;
      expiresAt: number;
      identifier: string;
      updatedAt: number;
      value: string;
      _id: Id<"verification">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "createdAt"
      | "expiresAt"
      | "identifier"
      | "updatedAt"
      | "value";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      expiresAt: ["expiresAt", "_creationTime"];
      identifier: ["identifier", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
};

/**
 * The names of all of your Convex tables.
 */
export type TableNames = TableNamesInDataModel<DataModel>;

/**
 * The type of a document stored in Convex.
 *
 * @typeParam TableName - A string literal type of the table name (like "users").
 */
export type Doc<TableName extends TableNames> = DocumentByName<
  DataModel,
  TableName
>;

/**
 * An identifier for a document in Convex.
 *
 * Convex documents are uniquely identified by their `Id`, which is accessible
 * on the `_id` field. To learn more, see [Document IDs](https://docs.convex.dev/using/document-ids).
 *
 * Documents can be loaded using `db.get(tableName, id)` in query and mutation functions.
 *
 * IDs are just strings at runtime, but this type can be used to distinguish them from other
 * strings when type checking.
 *
 * @typeParam TableName - A string literal type of the table name (like "users").
 */
export type Id<TableName extends TableNames | SystemTableNames> =
  GenericId<TableName>;
