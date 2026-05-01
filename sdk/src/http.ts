// ============================================================================
// Triologue SDK — HTTP Client (zero dependencies)
// ============================================================================

import type { ApiError } from './types';

export class TriologueHttpError extends Error {
  constructor(
    public statusCode: number,
    public body: ApiError,
  ) {
    super(body.error || body.message || `HTTP ${statusCode}`);
    this.name = 'TriologueHttpError';
  }
}

export interface HttpClientConfig {
  baseUrl: string;
  token: string;
  timeout: number;
}

export class HttpClient {
  private baseUrl: string;
  private token: string;
  private timeout: number;

  constructor(config: HttpClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
    this.timeout = config.timeout;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/json',
      };

      if (body) {
        headers['Content-Type'] = 'application/json';
      }

      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorBody: ApiError;
        try {
          errorBody = await response.json() as ApiError;
        } catch {
          errorBody = { error: `HTTP ${response.status}` };
        }
        throw new TriologueHttpError(response.status, errorBody);
      }

      // Handle 204 No Content
      if (response.status === 204) {
        return undefined as T;
      }

      return await response.json() as T;
    } finally {
      clearTimeout(timer);
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}
