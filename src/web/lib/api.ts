export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let requestAccount: string | null = null;
let accountGeneration = 0;
const privateRequests = new Set<AbortController>();

export function setRequestAccount(id: string | null) {
  if (id === requestAccount) return;
  requestAccount = id;
  accountGeneration++;
  for (const request of privateRequests) request.abort();
  privateRequests.clear();
}

async function request<T>(
  path: string,
  options: RequestInit,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  const expectedAccount = !['/api/session', '/api/login', '/api/logout'].includes(path)
    ? requestAccount
    : null;
  const generation = accountGeneration;
  const controller = expectedAccount ? new AbortController() : null;
  if (expectedAccount) {
    headers.set('X-Sidekick-Account', expectedAccount);
    privateRequests.add(controller!);
  }
  try {
    const response = await fetch(path, {
      ...options,
      headers,
      credentials: 'same-origin',
      signal: controller
        ? options.signal
          ? AbortSignal.any([controller.signal, options.signal])
          : controller.signal
        : options.signal,
    });
    if (
      controller?.signal.aborted ||
      options.signal?.aborted ||
      (expectedAccount && generation !== accountGeneration)
    )
      throw new DOMException('The account changed.', 'AbortError');
    if (
      response.status === 401 &&
      typeof window !== 'undefined' &&
      generation === accountGeneration &&
      !options.signal?.aborted
    )
      window.dispatchEvent(new Event('sidekick:unauthorized'));
    const result = await consume(response);
    if (
      controller?.signal.aborted ||
      options.signal?.aborted ||
      (expectedAccount && generation !== accountGeneration)
    )
      throw new DOMException('The account changed.', 'AbortError');
    return result;
  } finally {
    if (controller) privateRequests.delete(controller);
  }
}

export function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  return request(path, options, async (response) => {
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      throw new ApiError(
        typeof body?.error === 'string'
          ? body.error
          : 'The request could not be completed. Try again.',
        response.status,
      );
    }
    return response.json() as Promise<T>;
  });
}

export function apiResponse(path: string, options: RequestInit = {}): Promise<Response> {
  return request(
    path,
    options,
    async (response) =>
      new Response(response.status === 204 ? null : await response.arrayBuffer(), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
  );
}

export function post<T>(path: string, body: unknown = {}) {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}
