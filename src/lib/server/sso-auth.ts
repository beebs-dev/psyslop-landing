import { ApiError } from '$lib/api/error';
import type { RequestEvent } from '@sveltejs/kit';

const SSO_BASE = 'https://sso.slopindustries.com';
const REFRESH_COOKIE = 'promptslop_refresh';

export interface JwtLike {
	access_token: string;
	refresh_token?: string | null;
	token_type?: string | null;
	expires_in?: number | null;
	refresh_expires_in?: number | null;
	id_token?: string | null;
	scope?: string | null;
	session_state?: string | null;
}

export interface UserCredentials {
	id: string;
	username: string;
	email?: string | null;
	first_name?: string | null;
	last_name?: string | null;
	jwt: JwtLike;
	issued_at: number;
}

type RefreshCookie = {
	refresh_token: string;
	refresh_expires_at: number | null;
};

function safeJsonParse<T>(text: string): T | null {
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

function encodeRefreshCookie(value: RefreshCookie): string {
	return encodeURIComponent(Buffer.from(JSON.stringify(value), 'utf8').toString('base64'));
}

function decodeRefreshCookie(raw: string): RefreshCookie | null {
	try {
		const json = Buffer.from(decodeURIComponent(raw), 'base64').toString('utf8');
		const decoded = safeJsonParse<RefreshCookie>(json);
		if (!decoded?.refresh_token) return null;
		return decoded;
	} catch {
		return null;
	}
}

function getStoredRefresh(event: RequestEvent): RefreshCookie | null {
	const raw = event.cookies.get(REFRESH_COOKIE);
	if (!raw) return null;
	return decodeRefreshCookie(raw);
}

function storeRefresh(event: RequestEvent, refreshToken: string, refreshExpiresIn?: number | null) {
	const refreshExpiresAt =
		refreshExpiresIn && refreshExpiresIn > 0 ? Date.now() + refreshExpiresIn * 1000 : null;
	const value: RefreshCookie = {
		refresh_token: refreshToken,
		refresh_expires_at: refreshExpiresAt
	};

	// Keep httpOnly=false for compatibility with existing client-side auth.
	event.cookies.set(REFRESH_COOKIE, encodeRefreshCookie(value), {
		path: '/',
		sameSite: 'lax',
		httpOnly: false,
		secure: event.url.protocol === 'https:',
		expires: refreshExpiresAt ? new Date(refreshExpiresAt) : undefined
	});
}

function base64UrlDecode(input: string): string {
	const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
	return Buffer.from(padded, 'base64').toString('utf8');
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split('.');
	if (parts.length < 2) return null;
	try {
		return JSON.parse(base64UrlDecode(parts[1]!)) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function tokenHasAudience(token: string | null | undefined, expected: string): boolean {
	if (!token) return false;
	const payload = decodeJwtPayload(token);
	if (!payload) return false;
	const aud = payload['aud'];
	if (typeof aud === 'string') return aud === expected;
	if (Array.isArray(aud)) return aud.includes(expected);
	return false;
}

export function bearerForApi(creds: UserCredentials): string {
	const expectedAudiences = ['psysloptv', 'api.slopindustries.com'];
	const access = creds.jwt.access_token;
	const idToken = creds.jwt.id_token;

	for (const expectedAud of expectedAudiences) {
		if (tokenHasAudience(access, expectedAud)) return `Bearer ${access}`;
		if (tokenHasAudience(idToken, expectedAud)) return `Bearer ${idToken}`;
	}

	return `Bearer ${access}`;
}

async function authFetch<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${SSO_BASE}${path}`, {
		...init,
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			...(init?.headers ?? {})
		}
	});

	if (!res.ok) {
		const bodyText = await res.text().catch(() => '');
		throw new ApiError(`API ${res.status} ${res.statusText}`, res.status, bodyText);
	}

	const text = await res.text();
	return (text ? (JSON.parse(text) as T) : (undefined as T));
}

async function userRefreshWithToken(refreshToken: string): Promise<UserCredentials> {
	const response = await authFetch<Omit<UserCredentials, 'issued_at'>>('/user/refresh', {
		method: 'POST',
		body: JSON.stringify({ refresh_token: refreshToken })
	});

	return {
		...response,
		issued_at: Date.now(),
		jwt: {
			...response.jwt,
			refresh_token: undefined
		}
	};
}

async function userLoginWithPassword(username: string, password: string): Promise<UserCredentials> {
	const response = await authFetch<Omit<UserCredentials, 'issued_at'>>('/user/login', {
		method: 'POST',
		body: JSON.stringify({ username, password })
	});

	return {
		...response,
		issued_at: Date.now(),
		jwt: {
			...response.jwt,
			refresh_token: undefined
		}
	};
}

export async function getBearerFromEvent(event: RequestEvent): Promise<string | null> {
	const incoming = event.request.headers.get('authorization');
	if (incoming && /^Bearer\s+.+/i.test(incoming)) return incoming;

	const stored = getStoredRefresh(event);
	if (!stored) return null;
	if (stored.refresh_expires_at && Date.now() > stored.refresh_expires_at) return null;

	const refreshed = await userRefreshWithToken(stored.refresh_token);
	storeRefresh(event, stored.refresh_token, refreshed.jwt.refresh_expires_in);
	return bearerForApi(refreshed);
}

export async function getUserFromEvent(event: RequestEvent): Promise<UserCredentials | null> {
	const stored = getStoredRefresh(event);
	if (!stored) return null;
	if (stored.refresh_expires_at && Date.now() > stored.refresh_expires_at) return null;

	const refreshed = await userRefreshWithToken(stored.refresh_token);
	storeRefresh(event, stored.refresh_token, refreshed.jwt.refresh_expires_in);
	return refreshed;
}

export async function loginFromEvent(
	event: RequestEvent,
	username: string,
	password: string
): Promise<UserCredentials> {
	const response = await authFetch<Omit<UserCredentials, 'issued_at'>>('/user/login', {
		method: 'POST',
		body: JSON.stringify({ username, password })
	});

	const refresh = response.jwt.refresh_token;
	if (!refresh) throw new ApiError('Login did not return a refresh token', 502);
	storeRefresh(event, refresh, response.jwt.refresh_expires_in);

	return {
		...response,
		issued_at: Date.now(),
		jwt: {
			...response.jwt,
			refresh_token: undefined
		}
	};
}
