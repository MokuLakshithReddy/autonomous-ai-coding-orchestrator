export const TOKEN_STORAGE_KEY = 'orchestrator_api_token';

export function getStoredApiToken(): string {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setStoredApiToken(token: string): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {}
}

export interface ApiFetchOptions extends RequestInit {
  explicitToken?: string;
  onUnauthorized?: () => void;
}

export async function apiFetch(
  url: string,
  options: ApiFetchOptions = {}
): Promise<Response> {
  const { explicitToken, onUnauthorized, ...fetchInit } = options;
  const token = explicitToken ?? getStoredApiToken();

  const headers: Record<string, string> = {
    ...((fetchInit.headers as Record<string, string>) || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
    headers['x-api-token'] = token;
  }

  const res = await fetch(url, { ...fetchInit, headers });

  if (res.status === 401 && onUnauthorized) {
    onUnauthorized();
  }

  return res;
}

export async function requestWsTicket(explicitToken?: string): Promise<string | null> {
  const token = explicitToken ?? getStoredApiToken();
  if (!token) return null;

  try {
    const res = await fetch('/api/auth/ws-ticket', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-api-token': token,
      },
    });

    if (res.ok) {
      const data = await res.json();
      return data.ticket || null;
    }
  } catch (err) {
    console.warn('Failed to obtain WebSocket connection ticket:', err);
  }
  return null;
}

