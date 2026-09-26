export interface CredentialKeyStore {
  id: string;
  configured: boolean;
  getKey(): Promise<Buffer>;
}
