# Enterprise EKS platform

This module is applied from customer-owned CodeBuild after the private EKS
cluster exists. It composes the shared Kortix EKS platform and adds only the
single-tenant application boundary:

- the application namespace and IRSA-enabled service account;
- a namespaced External Secrets `SecretStore`; and
- the `kortix-runtime` `ExternalSecret` backed by customer Secrets Manager.

Argo CD is headless. It reconciles only the immutable overlay contained in a
verified enterprise release; there is no customer fork or customer desired-
state repository. The Kubernetes and Helm providers connect to the private EKS
endpoint from inside the VPC, never from Kortix GitHub.
