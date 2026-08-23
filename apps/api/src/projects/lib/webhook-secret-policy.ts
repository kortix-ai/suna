import {
  getProjectSecretConsumerConfigurationStatus,
  type ProjectSecretConsumerConfigurationStatus,
} from "../secrets";

export type WebhookSecretErrorCode =
  | "webhook_secret_missing"
  | "webhook_secret_inactive"
  | "webhook_secret_delivery_mismatch"
  | "webhook_secret_unavailable";

export interface WebhookSecretConfigurationError {
  error: string;
  code: WebhookSecretErrorCode;
  remediation: string;
}

export function webhookSecretConfigurationError(
  status:
    | Exclude<ProjectSecretConsumerConfigurationStatus, "configured">
    | "unavailable",
): WebhookSecretConfigurationError {
  if (status === "missing") {
    return {
      error: "Webhook secret is not configured",
      code: "webhook_secret_missing",
      remediation:
        "Create the referenced secret, then set its delivery to broker with consumer connector.",
    };
  }
  if (status === "inactive") {
    return {
      error: "Webhook secret is disabled",
      code: "webhook_secret_inactive",
      remediation:
        "Set the referenced secret value, then set its delivery to broker with consumer connector.",
    };
  }
  if (status === "delivery_mismatch") {
    return {
      error: "Webhook secret is not available to the connector consumer",
      code: "webhook_secret_delivery_mismatch",
      remediation: "Set the secret delivery to broker with consumer connector.",
    };
  }
  return {
    error: "Webhook secret is unavailable",
    code: "webhook_secret_unavailable",
    remediation: "Rotate the secret value and retry the request.",
  };
}

export async function validateWebhookSecretConfiguration(input: {
  projectId: string;
  secretEnv: string;
}): Promise<WebhookSecretConfigurationError | null> {
  const status = await getProjectSecretConsumerConfigurationStatus({
    projectId: input.projectId,
    name: input.secretEnv,
    consumer: "connector",
  });
  return status === "configured"
    ? null
    : webhookSecretConfigurationError(status);
}
