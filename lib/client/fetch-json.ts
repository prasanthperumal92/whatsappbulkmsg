export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init && { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new RequestError(res.status, body?.error?.message ?? 'Something went wrong. Please try again.');
  return body as T;
}
