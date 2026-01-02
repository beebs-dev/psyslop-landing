import type { LayoutServerLoad } from './$types';
import { getUserFromEvent } from '$lib/server/sso-auth';

export const load: LayoutServerLoad = async (event) => {
	if (event.locals.user) return { username: event.locals.user.username };

	try {
		const user = await getUserFromEvent(event);
		return { username: user?.username ?? null };
	} catch {
		// If SSO is down / refresh fails, don't block the landing site.
		return { username: null };
	}
};
