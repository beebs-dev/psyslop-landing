import type { Handle } from '@sveltejs/kit';
import { initPostgres } from '$lib/server/postgres';
import { clearAuthCookies, getBearerFromEvent, getUserFromEvent } from '$lib/server/sso-auth';
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

    // Optionally populate user info if a valid token is present, but don't require login.
    try {
        const bearer = await getBearerFromEvent(event);
        if (bearer) {
            const token = bearer.replace(/^Bearer\s+/i, '').trim();
            if (token && isKeycloakEnabled()) {
                await verifyKeycloakAccessToken(token);
            }
            event.locals.bearer = bearer;
            event.locals.user = await getUserFromEvent(event);
        }
    } catch {
        // Token invalid or missing - continue without auth
        clearAuthCookies(event);
    }

    return resolve(event);
};
