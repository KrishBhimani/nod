import type { DeploymentInput, DeploymentReceipt } from './deployment.ts';

export interface TenantRuntimeHost {
  fetch(
    ownerId: string,
    request: Request,
    options: {
      developer: boolean;
      kind?: 'user' | 'webhook' | 'wake';
    },
  ): Promise<Response>;
  prepareDeployment?(input: DeploymentInput): Promise<DeploymentReceipt[]>;
  resumeDeployment?(input: DeploymentInput): Promise<void>;
  close(): Promise<void>;
}
