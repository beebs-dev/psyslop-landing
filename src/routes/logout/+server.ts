import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clearAuthCookies } from '$lib/server/sso-auth';

export const POST: RequestHandler = async (event) => {
	clearAuthCookies(event);
	throw redirect(303, '/');
};
