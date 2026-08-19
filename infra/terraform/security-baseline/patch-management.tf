# Automated weekly security patching for the EC2 worker fleet.
#
# The associations target stable EKS cluster tags rather than current instance
# IDs, so replacement and autoscaled nodes enter the patch schedule
# automatically. max_concurrency=1 keeps Kubernetes capacity available while a
# node installs packages and reboots. AWS-RunPatchBaseline records execution
# and compliance state in Systems Manager for audit sampling.

# EKS was decommissioned 2026-08-02. The SSM associations that targeted
# eks:cluster-name tags have been removed.
