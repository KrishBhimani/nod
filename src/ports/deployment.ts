export type DeploymentInput = {
  nonce: string;
  targetRelease: string;
  deadline: number;
};

export type DeploymentRequest = DeploymentInput & {
  action: 'prepare' | 'status' | 'activate' | 'abort' | 'complete';
  previousRelease: string;
};

export type DeploymentReceipt = {
  ownerId: string;
  generation: string;
};

export interface TenantDrain {
  prepare(input: DeploymentInput): Promise<void>;
  resume(input: DeploymentInput): Promise<void>;
  active(): boolean;
  computerPaused?(): boolean;
}
