import type { Handle } from '@sveltejs/kit';
import { initPostgres } from '$lib/server/postgres';

// Connect to Postgres once when the server starts.
// Analytics inserts are best-effort, so don't crash the whole app if Postgres is unavailable.
try {
    await initPostgres();
} catch (e) {
    console.error('Postgres init failed; continuing without DB', e);
}

export const handle: Handle = async ({ event, resolve }) => {
    return resolve(event);
};
