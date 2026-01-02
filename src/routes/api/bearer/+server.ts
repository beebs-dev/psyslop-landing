import { getBearerFromEvent } from '$lib/server/sso-auth';
import { json, type RequestHandler } from '@sveltejs/kit';

export const GET: RequestHandler = async (event) => {
	const bearer = await getBearerFromEvent(event);
	if (!bearer) {
		return json({ error: 'Unauthorized' }, { status: 401, headers: { 'cache-control': 'no-store' } });
	}

	return json({ bearer }, { headers: { 'cache-control': 'no-store' } });
};
