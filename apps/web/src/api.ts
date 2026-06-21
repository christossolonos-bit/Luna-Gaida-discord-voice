export interface Me { user: { id: string; username: string; avatar: string | null }; csrfToken: string; owner: boolean }
export interface Guild { id: string; name: string; icon?: string | null; owner?: boolean }

let csrfToken = '';

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...init.headers
    }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText })) as { error?: string; issues?: Array<{ path?: string; message?: string }> };
    const issue = payload.issues?.[0];
    const detail = issue ? `${issue.path ? `${issue.path}: ` : ''}${issue.message ?? 'invalid value'}` : '';
    throw new Error([payload.error ?? `HTTP ${response.status}`, detail].filter(Boolean).join(' — '));
  }
  return response.json() as Promise<T>;
}

export async function loadMe() {
  const me = await api<Me>('/api/me');
  csrfToken = me.csrfToken;
  return me;
}

export function json(value: unknown): BodyInit {
  return JSON.stringify(value);
}
