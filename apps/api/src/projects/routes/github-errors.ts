import { GitHubApiError } from '../github';
import { GitHubCredentialResolutionError } from '../nango/account-credential';
import { GitHubCredentialModeError } from '../nango/credential-mode';
import { isNangoError } from '../nango/errors';
import { GitHubRepositoryValidationError } from '../nango/repository-operations';

export interface GitHubOperationErrorResponse {
  status: number;
  retryAfter?: string;
  body: {
    error: string;
    code: string;
    account_id?: string;
    installation_id?: string;
    requires_human_oauth?: true;
    sdk_action?: string;
  };
}

function humanOauthGuidance(error: GitHubCredentialResolutionError): GitHubOperationErrorResponse {
  return {
    status: error.status,
    body: {
      error: error.message,
      code: error.code,
      account_id: error.accountId,
      ...(error.installationId ? { installation_id: error.installationId } : {}),
      requires_human_oauth: true,
      sdk_action:
        error.code === 'github_connection_required'
          ? 'createGitHubConnectSession'
          : 'createGitHubReconnectSession',
    },
  };
}

export function mapGitHubOperationError(error: unknown): GitHubOperationErrorResponse {
  if (error instanceof GitHubCredentialResolutionError) {
    return humanOauthGuidance(error);
  }
  if (error instanceof GitHubCredentialModeError) {
    return {
      status: error.status,
      body: {
        error: error.message,
        code: error.code,
        requires_human_oauth: true,
        sdk_action: 'createGitHubConnectSession',
      },
    };
  }
  if (error instanceof GitHubRepositoryValidationError) {
    return {
      status: error.status,
      body: { error: error.message, code: error.code },
    };
  }
  if (isNangoError(error)) {
    return {
      status: error.status,
      ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
      body: {
        error: error.message,
        code: error.code,
      },
    };
  }
  if (error instanceof GitHubApiError) {
    if (error.status === 401) {
      return {
        status: 409,
        body: {
          error: 'The GitHub connection must be reconnected.',
          code: 'github_reconnect_required',
          requires_human_oauth: true,
          sdk_action: 'createGitHubReconnectSession',
        },
      };
    }
    if (error.status === 403) {
      return {
        status: 403,
        body: {
          error: 'The GitHub connection does not permit this operation.',
          code: 'github_insufficient_permissions',
        },
      };
    }
    if (error.status === 404) {
      return {
        status: 404,
        body: {
          error: 'The selected GitHub repository or branch no longer exists.',
          code: 'github_repository_not_found',
        },
      };
    }
    if (error.status === 429) {
      return {
        status: 429,
        ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
        body: {
          error: 'GitHub rate-limited the request.',
          code: 'github_provider_rate_limited',
        },
      };
    }
  }

  return {
    status: 502,
    body: {
      error: 'GitHub rejected the operation.',
      code: 'github_provider_failed',
    },
  };
}
