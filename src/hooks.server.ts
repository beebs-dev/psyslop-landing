import type { Handle } from '@sveltejs/kit';
import { initPostgres } from '$lib/server/postgres';
import { redirect } from '@sveltejs/kit';
import { clearAuthCookies, getBearerFromEvent, getUserFromEvent, inspectJwt } from '$lib/server/sso-auth';
import { isKeycloakEnabled, verifyKeycloakAccessToken } from '$lib/server/keycloak';

// Connect to Postgres once when the server starts.
// Analytics inserts are best-effort, so don't crash the whole app if Postgres is unavailable.
try {
    await initPostgres();
} catch (e) {
    console.error('Postgres init failed; continuing without DB', e);
}

export const handle: Handle = async ({ event, resolve }) => {
    event.locals.user = null;
    event.locals.bearer = null;

    const pathname = event.url.pathname;
    const isProtected = pathname === '/' || pathname.startsWith('/api/');

    if (isProtected) {
        let bearer: string | null = null;
        try {
            bearer = await getBearerFromEvent(event);
            if (bearer) {
                const token = bearer.replace(/^Bearer\s+/i, '').trim();
                if (token && isKeycloakEnabled()) {
                    await verifyKeycloakAccessToken(token);
                }
            }
        } catch (e) {
            const maybeToken = bearer?.replace(/^Bearer\s+/i, '').trim() ?? '';
            const claims = maybeToken ? inspectJwt(maybeToken) : null;
            console.warn('[AUTH] token verification failed:', e instanceof Error ? e.message : e);
            console.warn('[AUTH] denied', {
                path: pathname,
                reason: e instanceof Error ? e.message : String(e),
                keycloakEnabled: isKeycloakEnabled(),
                claims
            });
            bearer = null;
            clearAuthCookies(event);
        }

        if (!bearer) {
            console.warn('[AUTH] missing bearer', { path: pathname });
            if (pathname.startsWith('/api/')) {
                return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                    status: 401,
                    headers: {
                        'content-type': 'application/json',
                        'cache-control': 'no-store'
                    }
                });
            }

            const returnTo = `${event.url.pathname}${event.url.search}`;
            throw redirect(303, `/login?returnTo=${encodeURIComponent(returnTo)}`);
        }

        // Populate layout with username when possible.
        try {
            event.locals.user = await getUserFromEvent(event);
            event.locals.bearer = bearer;
        } catch {
            // ignore
        }
    }

    return resolve(event);
};
