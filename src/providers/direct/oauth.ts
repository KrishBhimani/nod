import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { CredentialKeyStore } from '../../ports/key-store.ts';
import { loadDirectPlugin } from './plugin.ts';

export type Service = 'notion' | 'linear';
type Secrets = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
  verifier?: string;
  redirectUri?: string;
  tokenEndpoint?: string;
  issuer?: string;
  requireIssuer?: boolean;
  resource?: string;
};
type AccountRow = {
  id: string;
  owner_id: string;
  service: Service;
  ciphertext: string;
  state_hash: string | null;
  expires_at: Date | null;
  connected: boolean;
};
const oauthQuery = z.object({
  state: z.string().min(1),
  code: z.string().min(1).optional(),
  iss: z.string().optional(),
  error: z.string().optional(),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

function seal(key: Buffer, id: string, secrets: Secrets) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`otto-direct-oauth-v1:${id}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(secrets)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64');
}

function open(key: Buffer, row: AccountRow): Secrets {
  const bytes = Buffer.from(row.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(`otto-direct-oauth-v1:${row.id}`));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
  );
}

function challenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function json(response: Response) {
  if (!response.ok) throw new Error(`Provider request failed (${response.status}).`);
  return response.json();
}

export function createDirectOAuth(options: {
  pool: Pool;
  keyStore: CredentialKeyStore;
  request: typeof fetch;
}) {
  const refreshes = new Map<string, Promise<Secrets>>();
  const ready = options.pool.query(`CREATE TABLE IF NOT EXISTS direct_oauth_accounts (
    id uuid PRIMARY KEY, owner_id text NOT NULL, service text NOT NULL, ciphertext text NOT NULL,
    state_hash text UNIQUE, expires_at timestamptz, connected boolean NOT NULL DEFAULT false
  )`);

  async function key() {
    if (!options.keyStore.configured) throw new Error('The secure key store is unavailable.');
    return options.keyStore.getKey();
  }

  async function row(id: string, ownerId: string) {
    await ready;
    const result = await options.pool.query<AccountRow>(
      `SELECT id,owner_id,service,ciphertext,state_hash,expires_at,connected FROM direct_oauth_accounts
       WHERE id=$1 AND connected=true AND owner_id=$2`,
      [id, ownerId],
    );
    if (!result.rows[0]) throw new Error('This connected account is unavailable.');
    return result.rows[0];
  }

  async function update(id: string, secrets: Secrets) {
    await options.pool.query('UPDATE direct_oauth_accounts SET ciphertext=$2 WHERE id=$1', [
      id,
      seal(await key(), id, secrets),
    ]);
  }

  async function access(account: AccountRow): Promise<Secrets> {
    const secrets = open(await key(), account);
    if (!secrets.accessToken) throw new Error('The connected account has no access token.');
    if (!secrets.expiresAt || secrets.expiresAt > Date.now() + 60_000) return secrets;
    const current = refreshes.get(account.id);
    if (current) return current;
    const pending = (async () => {
      if (!secrets.refreshToken || !secrets.tokenEndpoint)
        throw new Error('Connect this account again.');
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: secrets.refreshToken,
        client_id: secrets.clientId,
      });
      if (secrets.resource) body.set('resource', secrets.resource);
      const refreshed = tokenSchema.parse(
        await json(await options.request(secrets.tokenEndpoint, { method: 'POST', body })),
      );
      const next: Secrets = {
        ...secrets,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? secrets.refreshToken,
        expiresAt:
          refreshed.expires_in !== undefined ? Date.now() + refreshed.expires_in * 1000 : undefined,
      };
      await update(account.id, next);
      return next;
    })();
    refreshes.set(account.id, pending);
    try {
      return await pending;
    } finally {
      refreshes.delete(account.id);
    }
  }

  async function authorize(ownerId: string, service: Service, callbackUrl: string) {
    await ready;
    await options.pool.query(
      'DELETE FROM direct_oauth_accounts WHERE owner_id=$1 AND connected=false AND expires_at<now()',
      [ownerId],
    );
    await options.pool.query(
      'UPDATE direct_oauth_accounts SET state_hash=NULL,expires_at=NULL WHERE owner_id=$1 AND connected=true AND expires_at<now()',
      [ownerId],
    );
    const callback = new URL(callbackUrl);
    const nonce = callback.searchParams.get('state');
    if (!nonce) throw new Error('The connection state is missing.');
    callback.search = '';
    callback.hash = '';
    if (callback.hostname === 'localhost') callback.hostname = '127.0.0.1';
    const id = randomUUID();
    const verifier = randomBytes(32).toString('base64url');
    const endpoint = await loadDirectPlugin(service);
    const server = endpoint.origin;
    const resourceUrl = service === 'linear' ? endpoint.href : undefined;
    const resource = z
      .object({ authorization_servers: z.array(z.string().url()).min(1) })
      .parse(
        await json(
          await options.request(
            `${server}/.well-known/oauth-protected-resource${service === 'linear' ? endpoint.pathname : ''}`,
          ),
        ),
      );
    if (resource.authorization_servers[0] !== server)
      throw new Error('The authorization server changed.');
    const metadata = z
      .object({
        issuer: z.string().url(),
        authorization_response_iss_parameter_supported: z.boolean().optional(),
        authorization_endpoint: z.string().url(),
        token_endpoint: z.string().url(),
        registration_endpoint: z.string().url(),
      })
      .parse(await json(await options.request(`${server}/.well-known/oauth-authorization-server`)));
    if (
      metadata.issuer !== server ||
      ![
        metadata.authorization_endpoint,
        metadata.token_endpoint,
        metadata.registration_endpoint,
      ].every((url) => new URL(url).origin === server)
    )
      throw new Error('The OAuth endpoint changed.');
    const registration = z.object({ client_id: z.string().min(1) }).parse(
      await json(
        await options.request(metadata.registration_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_name: 'Otto',
            redirect_uris: [callback.href],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            ...(service === 'linear' ? { scope: 'read' } : {}),
          }),
        }),
      ),
    );
    const secrets: Secrets = {
      clientId: registration.client_id,
      verifier,
      redirectUri: callback.href,
      tokenEndpoint: metadata.token_endpoint,
      issuer: metadata.issuer,
      requireIssuer: metadata.authorization_response_iss_parameter_supported === true,
      resource: resourceUrl,
    };
    await options.pool.query(
      `INSERT INTO direct_oauth_accounts(id,owner_id,service,ciphertext,state_hash,expires_at)
       VALUES($1,$2,$3,$4,$5,now() + interval '10 minutes')`,
      [
        id,
        ownerId,
        service,
        seal(await key(), id, secrets),
        createHash('sha256').update(nonce).digest('hex'),
      ],
    );
    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', registration.client_id);
    url.searchParams.set('redirect_uri', callback.href);
    url.searchParams.set('state', nonce);
    url.searchParams.set('code_challenge', challenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    if (service === 'notion') {
      url.searchParams.set('scope', 'default');
    } else {
      url.searchParams.set('scope', 'read');
      url.searchParams.set('resource', resourceUrl!);
    }
    return { accountId: id, url: url.href };
  }

  async function parseCallback(raw: unknown) {
    const input = oauthQuery.parse(raw);
    await ready;
    const hash = createHash('sha256').update(input.state).digest('hex');
    const result = await options.pool.query<AccountRow>(
      `SELECT id,owner_id,service,ciphertext,state_hash,expires_at,connected FROM direct_oauth_accounts
       WHERE state_hash=$1 AND expires_at>now()`,
      [hash],
    );
    const pending = result.rows[0];
    if (!pending) throw new Error('This sign-in link is expired or already used.');
    const secrets = open(await key(), pending);
    if (input.iss !== undefined && input.iss !== secrets.issuer)
      throw new Error('The authorization server changed.');
    if (secrets.requireIssuer && input.iss !== secrets.issuer)
      throw new Error('The authorization server did not identify itself.');
    if (pending.connected) return { state: input.state, accountId: pending.id, success: true };
    if (input.error || !input.code) {
      await options.pool.query(
        'DELETE FROM direct_oauth_accounts WHERE id=$1 AND connected=false',
        [pending.id],
      );
      return { state: input.state, accountId: pending.id, success: false };
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: secrets.clientId,
      redirect_uri: secrets.redirectUri!,
      code_verifier: secrets.verifier!,
    });
    if (secrets.resource) body.set('resource', secrets.resource);
    const tokens = tokenSchema.parse(
      await json(await options.request(secrets.tokenEndpoint!, { method: 'POST', body })),
    );
    const connected: Secrets = {
      clientId: secrets.clientId,
      tokenEndpoint: secrets.tokenEndpoint,
      issuer: secrets.issuer,
      requireIssuer: secrets.requireIssuer,
      resource: secrets.resource,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt:
        tokens.expires_in !== undefined ? Date.now() + tokens.expires_in * 1000 : undefined,
    };
    const saved = await options.pool.query(
      `UPDATE direct_oauth_accounts SET ciphertext=$2,connected=true
       WHERE id=$1 AND state_hash=$3 AND connected=false`,
      [pending.id, seal(await key(), pending.id, connected), hash],
    );
    if (!saved.rowCount) throw new Error('This sign-in link was already used.');
    return { state: input.state, accountId: pending.id, success: true };
  }

  return {
    ready,
    authorize,
    parseCallback,
    async access(ownerId: string, id: string) {
      const account = await row(id, ownerId);
      const secrets = await access(account);
      return { service: account.service, accessToken: secrets.accessToken! };
    },
    async deleteAccount(id: string) {
      await ready;
      await options.pool.query('DELETE FROM direct_oauth_accounts WHERE id=$1', [id]);
    },
  };
}
