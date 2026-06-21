let csrfToken = '';
export async function api(path, init = {}) {
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
        const payload = await response.json().catch(() => ({ error: response.statusText }));
        const issue = payload.issues?.[0];
        const detail = issue ? `${issue.path ? `${issue.path}: ` : ''}${issue.message ?? 'invalid value'}` : '';
        throw new Error([payload.error ?? `HTTP ${response.status}`, detail].filter(Boolean).join(' — '));
    }
    return response.json();
}
export async function loadMe() {
    const me = await api('/api/me');
    csrfToken = me.csrfToken;
    return me;
}
export function json(value) {
    return JSON.stringify(value);
}
