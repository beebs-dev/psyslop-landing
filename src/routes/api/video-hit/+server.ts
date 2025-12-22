import { json, type RequestHandler } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { getPostgresPool } from '$lib/server/postgres';
import { recordVideoHit } from '$lib/server/hit-metrics';

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
    //console.log('headers (ip-related):', {
    //    xff: request.headers.get('x-forwarded-for'),
    //    xri: request.headers.get('x-real-ip'),
    //    xfp: request.headers.get('x-forwarded-proto'),
    //    via: request.headers.get('via'),
    //    fwd: request.headers.get('forwarded'),
    //    cfConnectingIp: request.headers.get('cf-connecting-ip'),
    //    trueClientIp: request.headers.get('true-client-ip')
    //});

    let videoId: string | null = null;

    try {
        const body = (await request.json()) as unknown;
        if (typeof body === 'object' && body !== null && 'videoId' in body) {
            const raw = (body as { videoId?: unknown }).videoId;
            if (typeof raw === 'string') videoId = raw.trim();
        }
    } catch {
        // ignore JSON parse errors; handled below
    }

    if (!videoId) {
        return json({ error: 'Missing videoId' }, { status: 400 });
    }

    const pool = getPostgresPool();
    const id = randomUUID();
    const timestamp = Date.now();
    const ipAddress = request.headers.get('x-forwarded-for') ?? getClientAddress();
    const useragent = request.headers.get('user-agent')?.trim() || 'unknown';

    await pool.query(
        'insert into video_hits (id, video_id, ip_address, useragent, timestamp) values ($1, $2, $3, $4, $5)',
        [id, videoId, ipAddress, useragent, timestamp]
    );

    recordVideoHit({
        videoId,
        ipAddress,
        useragent,
    });

    console.log('[VIDEO]', ipAddress, 'user-agent:', useragent, 'video:', videoId);

    return new Response(null, { status: 204 });
};
