import type { ServiceDef, SystemInfo } from './types';

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new Error(res.status === 429 ? 'Too many requests' : `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function checkAuth(): Promise<boolean> {
  const r = await request<{ authenticated: boolean }>('/api/me');
  return r.authenticated;
}

export async function login(password: string): Promise<boolean> {
  const r = await request<{ ok?: boolean; error?: string }>('/api/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  return !!r.ok;
}

export async function logout(): Promise<void> {
  await request('/api/logout', { method: 'POST' });
}

export async function fetchServices(): Promise<ServiceDef[]> {
  return request<ServiceDef[]>('/api/services');
}

export async function fetchSystem(): Promise<SystemInfo> {
  return request<SystemInfo>('/api/system');
}

export async function serviceAction(
  id: string,
  action: 'start' | 'stop' | 'restart',
): Promise<{ ok: boolean; error?: string }> {
  return request(`/api/services/${id}/${action}`, { method: 'POST' });
}
