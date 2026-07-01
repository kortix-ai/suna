/**
 * Platform API client — SSH setup API.
 */

export interface SSHConnectionInfo {
  host: string;
  port: number;
  username: string;
  provider: string;
  key_name: string;
  host_alias: string;
  reconnect_command: string;
  ssh_command: string;
  ssh_config_entry: string;
  ssh_config_command: string;
}

export interface SSHSetupResult extends SSHConnectionInfo {
  private_key: string;
  public_key: string;
  setup_command: string;
  agent_prompt: string;
  key_comment: string;
}

/**
 * Generate an SSH keypair and inject it into the active sandbox.
 * Returns the private key and connection details for VS Code Remote SSH.
 */
export async function setupSSH(sandboxId?: string): Promise<SSHSetupResult> {
  throw new Error('SSH setup is not exposed for project-session sandboxes');
}

export async function getSSHConnection(sandboxId?: string): Promise<SSHConnectionInfo> {
  throw new Error('SSH connection details are not exposed for project-session sandboxes');
}
