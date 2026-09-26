export type RuntimeConfiguration = {
  ownerId: string;
  generation: string;
  environment: Record<string, string>;
};

export interface RuntimeTransport {
  status(ownerId: string): Promise<{ generation: string | null; stopped: boolean }>;
  start(configuration: RuntimeConfiguration): Promise<void>;
  stop(ownerId: string, generation: string): Promise<void>;
  fetch(ownerId: string, request: Request): Promise<Response>;
  close(): Promise<void>;
}
