import type { RequestHandler } from '@sveltejs/kit';
import { renderPrometheusMetrics } from '$lib/server/hit-metrics';

export const GET: RequestHandler = async () => {
    const body = renderPrometheusMetrics();

    return new Response(body, {
        headers: {
            'content-type': 'text/plain; version=0.0.4; charset=utf-8',
            'cache-control': 'no-store'
        }
    });
};
