import { dev } from '$app/environment';
import { fetchWithAuth } from '$lib/server/sso-auth';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

type Video = {
	id: string;
	tags: string[];
};

function getVideoServiceBaseUrl(): string {
	// Per spec:
	// - development: https://api.slopindustries.com
	// - production:  http://slop-video.slop.svc.cluster.local
	return dev
		? 'https://api.slopindustries.com'
		: 'http://slop-video.slop.svc.cluster.local';
}

function toUpstreamUrl(videoId: string): string {
	return `${getVideoServiceBaseUrl()}/video/${encodeURIComponent(videoId)}`;
}

async function proxy(event: RequestEvent, init: RequestInit): Promise<Response> {
	const videoId = event.params.video_id;
	if (!videoId) {
		return new Response(JSON.stringify({ error: 'Missing video_id' }), {
			status: 400,
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
		});
	}

	const upstream = await fetchWithAuth(event, toUpstreamUrl(videoId), init);
	const body = await upstream.text().catch(() => '');
	return new Response(body, {
		status: upstream.status,
		headers: {
			'content-type': upstream.headers.get('content-type') ?? 'application/json',
			'cache-control': 'no-store'
		}
	});
}

export const GET: RequestHandler = async (event) => {
	return proxy(event, { method: 'GET' });
};

export const PUT: RequestHandler = async (event) => {
	const videoId = event.params.video_id;
	if (!videoId) {
		return new Response(JSON.stringify({ error: 'Missing video_id' }), {
			status: 400,
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
		});
	}

	const body = (await event.request.json().catch(() => null)) as
		| { tags?: unknown }
		| null;

	const tags = Array.isArray(body?.tags)
		? body!.tags.filter((t): t is string => typeof t === 'string')
		: null;

	if (!tags) {
		return new Response(JSON.stringify({ error: 'Invalid request body; expected { tags: string[] }' }), {
			status: 400,
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
		});
	}

	const payload: Video = {
		id: videoId,
		tags
	};

	const resp= await proxy(event, {
		method: 'PUT',
		headers: {
			'content-type': 'application/json'
		},
		body: JSON.stringify(payload)
	});
    if (resp.status > 299) {
        console.error(`Failed to update video ${videoId}: ${await resp.text()}`);
    }
    return resp;
};

export const DELETE: RequestHandler = async (event) => {
	return proxy(event, { method: 'DELETE' });
};
