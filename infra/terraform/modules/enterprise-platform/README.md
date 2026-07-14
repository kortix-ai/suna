# Enterprise EKS platform

This module is applied from customer-owned CodeBuild after the private EKS
cluster exists. It composes the shared Kortix EKS platform and adds only the
single-tenant application boundary:

- the application namespace and IRSA-enabled service account;
- a namespaced External Secrets `SecretStore`; and
- the `kortix-runtime` `ExternalSecret` backed by customer Secrets Manager.

The customer-owned enterprise updater is the single deployment authority. It
applies only the Terraform and Helm content from a verified immutable release;
Argo CD is deliberately not installed because a second reconciler would create
split ownership. Argo Rollouts remains available for progressive workload
rollouts. The Kubernetes and Helm providers connect to the private EKS endpoint
from inside the VPC, never from Kortix GitHub.
