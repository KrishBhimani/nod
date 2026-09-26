export interface TenantRuntimeHost {
  fetch(
    ownerId: string,
    request: Request,
    options: {
      developer: boolean;
      kind?: 'user' | 'webhook' | 'wake';
    },
  ): Promise<Response>;
  close(): Promise<void>;
}
