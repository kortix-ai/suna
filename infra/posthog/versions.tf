terraform {
  required_version = ">= 1.5"

  required_providers {
    posthog = {
      source  = "PostHog/posthog"
      version = "~> 1.0"
    }
  }
}

# Reads POSTHOG_API_KEY, POSTHOG_HOST and POSTHOG_PROJECT_ID from the environment.
# Re-pointing at another project, organization or region is an env change + apply.
provider "posthog" {}
