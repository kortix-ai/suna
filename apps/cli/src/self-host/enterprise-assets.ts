import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import clusterBackend from '../../../../infra/terraform/environments/enterprise-vpc-template/cluster/backend.tf' with { type: 'text' };
import clusterLock from '../../../../infra/terraform/environments/enterprise-vpc-template/cluster/.terraform.lock.hcl' with { type: 'text' };
import clusterMain from '../../../../infra/terraform/environments/enterprise-vpc-template/cluster/main.tf' with { type: 'text' };
import clusterVariables from '../../../../infra/terraform/environments/enterprise-vpc-template/cluster/variables.tf' with { type: 'text' };
import platformBackend from '../../../../infra/terraform/environments/enterprise-vpc-template/platform/backend.tf' with { type: 'text' };
import platformLock from '../../../../infra/terraform/environments/enterprise-vpc-template/platform/.terraform.lock.hcl' with { type: 'text' };
import platformMain from '../../../../infra/terraform/environments/enterprise-vpc-template/platform/main.tf' with { type: 'text' };
import platformVariables from '../../../../infra/terraform/environments/enterprise-vpc-template/platform/variables.tf' with { type: 'text' };
import stateBackend from '../../../../infra/terraform/environments/enterprise-vpc-template/state/backend.tf' with { type: 'text' };
import stateLock from '../../../../infra/terraform/environments/enterprise-vpc-template/state/.terraform.lock.hcl' with { type: 'text' };
import stateMain from '../../../../infra/terraform/environments/enterprise-vpc-template/state/main.tf' with { type: 'text' };
import stateVariables from '../../../../infra/terraform/environments/enterprise-vpc-template/state/variables.tf' with { type: 'text' };

import stateModuleMain from '../../../../infra/terraform/modules/enterprise-state/main.tf' with { type: 'text' };
import stateModuleOutputs from '../../../../infra/terraform/modules/enterprise-state/outputs.tf' with { type: 'text' };
import stateModuleVariables from '../../../../infra/terraform/modules/enterprise-state/variables.tf' with { type: 'text' };
import stateModuleVersions from '../../../../infra/terraform/modules/enterprise-state/versions.tf' with { type: 'text' };

import enterpriseBackup from '../../../../infra/terraform/modules/enterprise-vpc/backup.tf' with { type: 'text' };
import supabaseUserData from '../../../../infra/terraform/modules/enterprise-vpc/files/supabase-user-data.sh.tftpl' with { type: 'text' };
import enterpriseFlowLogs from '../../../../infra/terraform/modules/enterprise-vpc/flow-logs.tf' with { type: 'text' };
import enterpriseKms from '../../../../infra/terraform/modules/enterprise-vpc/kms.tf' with { type: 'text' };
import enterpriseMain from '../../../../infra/terraform/modules/enterprise-vpc/main.tf' with { type: 'text' };
import enterpriseNetwork from '../../../../infra/terraform/modules/enterprise-vpc/network.tf' with { type: 'text' };
import enterpriseOperator from '../../../../infra/terraform/modules/enterprise-vpc/operator.tf' with { type: 'text' };
import enterpriseOutputs from '../../../../infra/terraform/modules/enterprise-vpc/outputs.tf' with { type: 'text' };
import enterpriseStorage from '../../../../infra/terraform/modules/enterprise-vpc/storage.tf' with { type: 'text' };
import enterpriseSupabase from '../../../../infra/terraform/modules/enterprise-vpc/supabase.tf' with { type: 'text' };
import enterpriseVariables from '../../../../infra/terraform/modules/enterprise-vpc/variables.tf' with { type: 'text' };
import enterpriseVersions from '../../../../infra/terraform/modules/enterprise-vpc/versions.tf' with { type: 'text' };

import networkMain from '../../../../infra/terraform/modules/network/main.tf' with { type: 'text' };
import networkOutputs from '../../../../infra/terraform/modules/network/outputs.tf' with { type: 'text' };
import networkVariables from '../../../../infra/terraform/modules/network/variables.tf' with { type: 'text' };

import { instanceDir } from './config.ts';

const STATE_BACKEND_PATH = 'environments/enterprise-vpc/state/backend.tf';
export const LOCAL_STATE_BACKEND = stateBackend;

export const enterpriseTerraformAssets: Readonly<Record<string, string>> = {
  'environments/enterprise-vpc/cluster/.terraform.lock.hcl': clusterLock,
  'environments/enterprise-vpc/cluster/backend.tf': clusterBackend,
  'environments/enterprise-vpc/cluster/main.tf': clusterMain,
  'environments/enterprise-vpc/cluster/variables.tf': clusterVariables,
  'environments/enterprise-vpc/platform/.terraform.lock.hcl': platformLock,
  'environments/enterprise-vpc/platform/backend.tf': platformBackend,
  'environments/enterprise-vpc/platform/main.tf': platformMain,
  'environments/enterprise-vpc/platform/variables.tf': platformVariables,
  'environments/enterprise-vpc/state/.terraform.lock.hcl': stateLock,
  [STATE_BACKEND_PATH]: LOCAL_STATE_BACKEND,
  'environments/enterprise-vpc/state/main.tf': stateMain,
  'environments/enterprise-vpc/state/variables.tf': stateVariables,
  'modules/enterprise-state/main.tf': stateModuleMain,
  'modules/enterprise-state/outputs.tf': stateModuleOutputs,
  'modules/enterprise-state/variables.tf': stateModuleVariables,
  'modules/enterprise-state/versions.tf': stateModuleVersions,
  'modules/enterprise-vpc/backup.tf': enterpriseBackup,
  'modules/enterprise-vpc/files/supabase-user-data.sh.tftpl': supabaseUserData,
  'modules/enterprise-vpc/flow-logs.tf': enterpriseFlowLogs,
  'modules/enterprise-vpc/kms.tf': enterpriseKms,
  'modules/enterprise-vpc/main.tf': enterpriseMain,
  'modules/enterprise-vpc/network.tf': enterpriseNetwork,
  'modules/enterprise-vpc/operator.tf': enterpriseOperator,
  'modules/enterprise-vpc/outputs.tf': enterpriseOutputs,
  'modules/enterprise-vpc/storage.tf': enterpriseStorage,
  'modules/enterprise-vpc/supabase.tf': enterpriseSupabase,
  'modules/enterprise-vpc/variables.tf': enterpriseVariables,
  'modules/enterprise-vpc/versions.tf': enterpriseVersions,
  'modules/network/main.tf': networkMain,
  'modules/network/outputs.tf': networkOutputs,
  'modules/network/variables.tf': networkVariables,
};

export const REMOTE_STATE_BACKEND = `terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
  }
  backend "s3" {}
}
`;

export function enterpriseTerraformRoot(instance: string): string {
  return join(instanceDir(instance), 'terraform');
}

/**
 * Materialize the exact reviewed graph bundled into this CLI. Terraform state,
 * backend.hcl, generated tfvars, and the migrated state backend are mutable
 * instance data and are deliberately never overwritten here.
 */
export function writeEnterpriseTerraformAssets(instance: string): string {
  const root = enterpriseTerraformRoot(instance);
  for (const [relativePath, content] of Object.entries(enterpriseTerraformAssets)) {
    const path = join(root, relativePath);
    if (relativePath === STATE_BACKEND_PATH && existsSync(path)) {
      const current = readFileSync(path, 'utf8');
      if (current.includes('backend "s3"')) continue;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { encoding: 'utf8', mode: 0o644 });
    chmodSync(path, 0o644);
  }
  return root;
}

export function stateBackendPath(instance: string): string {
  return join(enterpriseTerraformRoot(instance), STATE_BACKEND_PATH);
}
