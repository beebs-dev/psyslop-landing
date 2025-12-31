import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const REFRESH_COOKIE = 'promptslop_refresh';

export const POST: RequestHandler = async (event) => {
	event.cookies.delete(REFRESH_COOKIE, { path: '/' });
	throw redirect(303, '/');
};
