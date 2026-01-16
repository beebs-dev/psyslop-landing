import { env } from '$env/dynamic/private';
import { ApiError } from '$lib/api/error';
import type { RequestEvent } from '@sveltejs/kit';

const REFRESH_COOKIE = 'promptslop_refresh';
const ACCESS_REFRESH_SKEW_MS = 20_000;

const getSsoBase = (): string => {
	return env.SSO_BASE_URL ?? 'https://sso.slopindustries.com';
}

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

type AccessCacheEntry = {
	access_token: string;
	expires_at: number | null;
	last_used_at: number;
};

const ACCESS_CACHE_MAX = 5000;
const accessCache = new Map<string, AccessCacheEntry>();

function safeJsonParse<T>(text: string): T | null {
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

function encodeRefreshCookie(value: RefreshCookie): string {
	// base64url keeps cookie values URL-safe without percent-encoding overhead.
	return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeRefreshCookie(raw: string): RefreshCookie | null {
	// Backward compatible decode:
	// - current: base64url(JSON)
	// - old: encodeURIComponent(base64(JSON))
	try {
		const json = Buffer.from(raw, 'base64url').toString('utf8');
		const decoded = safeJsonParse<RefreshCookie>(json);
		if (decoded?.refresh_token) return decoded;
	} catch {
		// ignore
	}

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
	const forwardedProto = event.request.headers.get('x-forwarded-proto');
	const forwarded = forwardedProto ? forwardedProto.split(',')[0]!.trim() : null;
	const isSecure = forwarded ? forwarded === 'https' : event.url.protocol === 'https:';
	const refreshExpiresAt =
		refreshExpiresIn && refreshExpiresIn > 0 ? Date.now() + refreshExpiresIn * 1000 : null;
	const value: RefreshCookie = {
		refresh_token: refreshToken,
		refresh_expires_at: refreshExpiresAt
	};

	// Keep httpOnly=false for compatibility with existing client-side auth.
	const encoded = encodeRefreshCookie(value);
	if (encoded.length > 3600) {
		console.warn('[AUTH] refresh cookie is large; may be dropped by browsers', {
			length: encoded.length
		});
	}

	event.cookies.set(REFRESH_COOKIE, encoded, {
		path: '/',
		sameSite: 'lax',
		httpOnly: false,
		secure: isSecure,
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

export function inspectJwt(token: string): Record<string, unknown> | null {
	const payload = decodeJwtPayload(token);
	if (!payload) return null;
	// Return only a minimal, non-sensitive subset.
	const keep = ['iss', 'aud', 'azp', 'exp', 'sub', 'preferred_username', 'typ', 'scope'] as const;
	const out: Record<string, unknown> = {};
	for (const k of keep) {
		if (k in payload) out[k] = payload[k];
	}
	return out;
}

function getJwtExpiresAt(token: string | null | undefined): number | null {
	if (!token) return null;
	const payload = decodeJwtPayload(token);
	if (!payload) return null;
	const exp = payload['exp'];
	if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
	return exp * 1000;
}

function isAccessExpiringSoon(entry: AccessCacheEntry | null | undefined, nowMs = Date.now()): boolean {
	if (!entry?.access_token) return true;
	if (!entry.expires_at) return true;
	return entry.expires_at - nowMs <= ACCESS_REFRESH_SKEW_MS;
}

function userFromAccessToken(accessToken: string): UserCredentials | null {
	const payload = decodeJwtPayload(accessToken);
	if (!payload) return null;

	const id = typeof payload['sub'] === 'string' ? payload['sub'] : '';
	const username =
		typeof payload['preferred_username'] === 'string'
			? payload['preferred_username']
			: typeof payload['username'] === 'string'
				? payload['username']
				: '';

	if (!id || !username) return null;

	return {
		id,
		username,
		email: typeof payload['email'] === 'string' ? payload['email'] : null,
		first_name:
			typeof payload['given_name'] === 'string'
				? payload['given_name']
				: typeof payload['first_name'] === 'string'
					? payload['first_name']
					: null,
		last_name:
			typeof payload['family_name'] === 'string'
				? payload['family_name']
				: typeof payload['last_name'] === 'string'
					? payload['last_name']
					: null,
		jwt: {
			access_token: accessToken
		},
		issued_at: Date.now()
	};
}

function trimAccessCacheIfNeeded() {
	if (accessCache.size <= ACCESS_CACHE_MAX) return;
	// Drop least-recently-used ~10%.
	const entries = Array.from(accessCache.entries());
	entries.sort((a, b) => a[1].last_used_at - b[1].last_used_at);
	const toDrop = Math.max(1, Math.floor(ACCESS_CACHE_MAX * 0.1));
	for (let i = 0; i < toDrop && i < entries.length; i++) {
		accessCache.delete(entries[i]![0]);
	}
}

async function getAccessTokenForRefresh(event: RequestEvent, refreshToken: string): Promise<string> {
	const now = Date.now();
	const cached = accessCache.get(refreshToken);
	if (cached && !isAccessExpiringSoon(cached, now)) {
		cached.last_used_at = now;
		return cached.access_token;
	}

	const refreshed = await userRefreshWithToken(refreshToken);
	const accessToken = refreshed.jwt.access_token;
	const expiresAt = getJwtExpiresAt(accessToken);
	accessCache.set(refreshToken, {
		access_token: accessToken,
		expires_at: expiresAt,
		last_used_at: now
	});
	trimAccessCacheIfNeeded();

	// Refresh endpoint can extend refresh lifetime.
	storeRefresh(event, refreshToken, refreshed.jwt.refresh_expires_in);
	return accessToken;
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
	return `Bearer ${creds.jwt.access_token}`;
}

async function authFetch<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${getSsoBase()}${path}`, {
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

	const storedRefresh = getStoredRefresh(event);
	if (!storedRefresh) return null;
	if (storedRefresh.refresh_expires_at && Date.now() > storedRefresh.refresh_expires_at) return null;

	const accessToken = await getAccessTokenForRefresh(event, storedRefresh.refresh_token);
	return `Bearer ${accessToken}`;
}

export async function getUserFromEvent(event: RequestEvent): Promise<UserCredentials | null> {
	const storedRefresh = getStoredRefresh(event);
	if (!storedRefresh) return null;
	if (storedRefresh.refresh_expires_at && Date.now() > storedRefresh.refresh_expires_at) return null;

	// Use cached access token when valid to avoid unnecessary refresh calls.
	const cached = accessCache.get(storedRefresh.refresh_token);
	if (cached && !isAccessExpiringSoon(cached)) {
		cached.last_used_at = Date.now();
		const user = userFromAccessToken(cached.access_token);
		if (user) return user;
	}

	const refreshed = await userRefreshWithToken(storedRefresh.refresh_token);
	storeRefresh(event, storedRefresh.refresh_token, refreshed.jwt.refresh_expires_in);
	accessCache.set(storedRefresh.refresh_token, {
		access_token: refreshed.jwt.access_token,
		expires_at: getJwtExpiresAt(refreshed.jwt.access_token),
		last_used_at: Date.now()
	});
	trimAccessCacheIfNeeded();
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

export async function fetchWithAuth(event: RequestEvent, input: RequestInfo | URL, init?: RequestInit) {
	const bearer = await getBearerFromEvent(event);
	if (!bearer) throw new ApiError('Not authenticated', 401);

	return fetch(input, {
		...init,
		headers: {
			...(init?.headers ?? {}),
			Authorization: bearer
		}
	});
}

export function clearAuthCookies(event: RequestEvent) {
	// keep existing cookie name for compatibility
	event.cookies.delete(REFRESH_COOKIE, { path: '/' });
}
