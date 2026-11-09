export type AuthUser = { id: string; email: string; role: 'owner' | 'member' };
export type AuthState = { setupRequired: boolean; lanMode: boolean; remoteAIAllowed?: boolean; user: AuthUser | null };
export type ManagedUser = AuthUser & { createdAt: string };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
  return payload;
}

export function getAuthState() {
  return request<AuthState>('/api/auth/status');
}

export function createOwnerAccount(input: { email: string; password: string; setupCode: string }) {
  return request<{ user: AuthUser }>('/api/auth/setup', { method: 'POST', body: JSON.stringify(input) });
}

export function signIn(input: { email: string; password: string }) {
  return request<{ user: AuthUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify(input) });
}

export function signOut() {
  return request<{ ok: true }>('/api/auth/logout', { method: 'POST', body: '{}' });
}

export function listManagedUsers() {
  return request<ManagedUser[]>('/api/auth/users');
}

export function createManagedUser(input: { email: string; password: string }) {
  return request<{ user: AuthUser }>('/api/auth/users', { method: 'POST', body: JSON.stringify(input) });
}
