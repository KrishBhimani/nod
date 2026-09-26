export type ComputerAllocationRole = 'browser' | 'workspace';

export interface ComputerAllocation {
  ownerId: string;
  role: ComputerAllocationRole;
  provider: string;
  templateId: string;
  resourceId: string | null;
  generation: string;
  version: number;
  state: 'allocating' | 'ready' | 'uncertain';
  leaseId: string | null;
  leaseExpiresAt: number | null;
}

export interface ComputerAllocationStore {
  read(ownerId: string, role: ComputerAllocationRole): Promise<ComputerAllocation | undefined>;
  compareAndSwap(expectedVersion: number | null, next: ComputerAllocation): Promise<boolean>;
}
