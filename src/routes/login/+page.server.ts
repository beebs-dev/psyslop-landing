import type { Actions, PageServerLoad } from './$types';
import { fail, redirect } from '@sveltejs/kit';
import { ApiError } from '$lib/api/error';
import { getUserFromEvent, loginFromEvent } from '$lib/server/sso-auth';

export const load: PageServerLoad = async (event) => {
	try {
		const user = await getUserFromEvent(event);
		return { username: user?.username ?? null };
	} catch {
		return { username: null };
	}
};

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const username = String(form.get('username') ?? '').trim();
		const password = String(form.get('password') ?? '');
		if (!username || !password) {
			return fail(400, { message: 'Username and password are required.' });
		}

		try {
			await loginFromEvent(event, username, password);
		} catch (e) {
			if (e instanceof ApiError) {
				return fail(e.status || 500, { message: 'Login failed.' });
			}
			return fail(500, { message: 'Login failed.' });
		}

		const returnToFromBody = String(form.get('returnTo') ?? '').trim();
		const returnToFromQuery = event.url.searchParams.get('returnTo') ?? '';
		const returnTo = returnToFromBody || returnToFromQuery || '/';
		// Prevent open redirects.
		const safeReturnTo = returnTo.startsWith('/') ? returnTo : '/';
		throw redirect(303, safeReturnTo);
	}
};
