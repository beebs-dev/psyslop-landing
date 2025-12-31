import { env } from '$env/dynamic/private';
import { error, json, type RequestHandler } from '@sveltejs/kit';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { getPostgresPool } from '$lib/server/postgres';
import { recordHomeHit } from '$lib/server/hit-metrics';

type VideoItem = {
    id: string;
    videoUrl: string;
    thumbUrl: string;
};

type VideosResponse = {
    items: VideoItem[];
    page: number;
    pageSize: number;
    hasMore: boolean;
    nextPage: number | null;
    total: number;
};

const CACHE_TTL_MS = 60_000 * 3;
const REFRESH_TIMEOUT_MS = 5_000;
let cache:
    | {
        fetchedAt: number;
        videoSlugs: string[];
    }
    | undefined;

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
};

const clampInt = (value: string | null, fallback: number, min: number, max: number) => {
    const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

const encodePath = (key: string) => key.split('/').map(encodeURIComponent).join('/');

const FULLRES_PREFIX = '_fullres/';
const THUMBS_PREFIX = '_thumbs/';
const FULLRES_SUFFIX = '.mp4';

type VideoSortBy = 'id' | 'created_at';

const getVideoSortBy = (): VideoSortBy => {
    const raw = (env.VIDEO_SORT_BY ?? '').trim().toLowerCase();
    if (!raw) return 'id';
    if (raw === 'id' || raw === 'created_at') return raw;
    console.warn(`[VIDEOS] Invalid VIDEO_SORT_BY="${env.VIDEO_SORT_BY}", defaulting to "id"`);
    return 'id';
};

const isDigits = (value: string) => /^\d+$/.test(value);

const compareSlugIdDesc = (a: string, b: string) => {
    const aIsNum = isDigits(a);
    const bIsNum = isDigits(b);

    // Prefer numeric ids before non-numeric slugs.
    if (aIsNum !== bIsNum) return aIsNum ? -1 : 1;

    if (aIsNum && bIsNum) {
        const aBig = BigInt(a);
        const bBig = BigInt(b);
        if (aBig === bBig) return 0;
        return aBig > bBig ? -1 : 1;
    }

    // Non-numeric slugs: fall back to lexicographic id ordering.
    return b.localeCompare(a);
};

const getCdnBaseUrl = () => {
    // Prefer explicit config, but default to the URL shape you provided.
    return env.SPACES_CDN_BASE_URL ?? 'https://slop.sfo3.cdn.digitaloceanspaces.com';
};

const getSpacesConfig = () => {
    const endpoint = env.SPACES_ENDPOINT ?? 'https://sfo3.digitaloceanspaces.com';
    const bucket = env.SPACES_BUCKET ?? 'slop';
    const region = env.AWS_REGION ?? 'sfo3';

    const accessKeyId = env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = env.AWS_SESSION_TOKEN;

    if (!accessKeyId || !secretAccessKey) {
        throw error(500, 'Missing AWS credentials: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY');
    }

    return {
        endpoint,
        bucket,
        region,
        credentials: {
            accessKeyId,
            secretAccessKey,
            sessionToken
        }
    };
};

const listAllMp4Keys = async (): Promise<string[]> => {
    const { endpoint, bucket, region, credentials } = getSpacesConfig();

    const client = new S3Client({
        region,
        endpoint,
        credentials,
        forcePathStyle: true
    });

    let continuationToken: string | undefined;
    const entries: Array<{ slug: string; lastModifiedMs: number }> = [];

    while (true) {
        const res = await client.send(
            new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: FULLRES_PREFIX,
                ContinuationToken: continuationToken
            })
        );

        for (const obj of res.Contents ?? []) {
            if (!obj.Key) continue;
            if (!obj.Key.startsWith(FULLRES_PREFIX)) continue;
            if (!obj.Key.toLowerCase().endsWith(FULLRES_SUFFIX)) continue;

            const file = obj.Key.slice(FULLRES_PREFIX.length);
            const slug = file.slice(0, -FULLRES_SUFFIX.length);
            if (!slug) continue;

            entries.push({
                slug,
                lastModifiedMs: obj.LastModified ? obj.LastModified.getTime() : 0
            });
        }

        if (!res.IsTruncated) break;
        continuationToken = res.NextContinuationToken;
        if (!continuationToken) break;
    }

    const sortBy = getVideoSortBy();
    if (sortBy === 'created_at') {
        // S3 doesn't expose a true "creation date" via ListObjects; LastModified is the closest available.
        // Most recent first.
        entries.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs || a.slug.localeCompare(b.slug));
    } else {
        // Default: id ordering (newest/highest id first).
        entries.sort((a, b) => compareSlugIdDesc(a.slug, b.slug));
    }
    return entries.map((e) => e.slug);
};

const getCachedMp4Keys = async (): Promise<string[]> => {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.videoSlugs;

    // If we have stale cache, try to refresh quickly; if refresh is slow/fails, serve stale.
    if (cache) {
        try {
            const refreshed = await withTimeout(
                listAllMp4Keys(),
                REFRESH_TIMEOUT_MS,
                `Spaces refresh timed out after ${REFRESH_TIMEOUT_MS}ms`
            );
            cache = { fetchedAt: now, videoSlugs: refreshed };
            return refreshed;
        } catch {
            // Avoid retrying refresh on every request when Spaces is slow/unreachable.
            cache = { fetchedAt: now, videoSlugs: cache.videoSlugs };
            return cache.videoSlugs;
        }
    }

    const mp4Keys = await withTimeout(
        listAllMp4Keys(),
        REFRESH_TIMEOUT_MS,
        `Spaces refresh timed out after ${REFRESH_TIMEOUT_MS}ms`
    );
    cache = { fetchedAt: now, videoSlugs: mp4Keys };
    return mp4Keys;
};

const toCdnUrl = (key: string) => {
    const base = getCdnBaseUrl();
    const normalized = base.endsWith('/') ? base.slice(0, -1) : base;
    return `${normalized}/${encodePath(key)}`;
};

const toThumbKey = (fullresKey: string) => {
    // _fullres/foo.mp4 -> _thumbs/foo.thumb.mp4
    if (!fullresKey.startsWith(FULLRES_PREFIX)) return fullresKey;
    const file = fullresKey.slice(FULLRES_PREFIX.length);
    if (file.toLowerCase().endsWith('.mp4')) {
        return `${THUMBS_PREFIX}${file.slice(0, -4)}.thumb.mp4`;
    }
    return `${THUMBS_PREFIX}${file}`;
};

export const GET: RequestHandler = async ({ url, request, getClientAddress }) => {

    const recordHit = async () => {
        const pool = getPostgresPool();
        const id = randomUUID();
        const timestamp = Date.now();
        const ipAddress = request.headers.get('x-forwarded-for') ?? getClientAddress();
        const useragent = request.headers.get('user-agent')?.trim() || 'unknown';
        const videoId = url.searchParams.get('v')?.trim() || null;
        console.log('[HOME]', ipAddress, 'user-agent:', useragent, 'video:', videoId);
        await pool.query(
            'insert into home_hits (id, ip_address, useragent, timestamp, video_id) values ($1, $2, $3, $4, $5)',
            [id, ipAddress, useragent, timestamp, videoId]
        );

        recordHomeHit({
            ipAddress,
            useragent,
            videoId,
        });
    };

    // Best-effort analytics: never break the response on insert errors.
    void recordHit().catch((e) => {
        console.error('Failed to record hit', e);
    });

    // Simple offset-pagination for now. Replace with cursor-based pagination later if desired.
    const page = clampInt(url.searchParams.get('page'), 1, 1, 10_000);
    const pageSize = clampInt(url.searchParams.get('pageSize'), 12, 1, 48);
    const videoSlugs = await getCachedMp4Keys();

    const start = (page - 1) * pageSize;
    const end = Math.min(start + pageSize, videoSlugs.length);

    const slice = videoSlugs.slice(start, end);
    const items: VideoItem[] = slice.map((slug) => {
        const fullresKey = `${FULLRES_PREFIX}${slug}${FULLRES_SUFFIX}`;
        const thumbKey = toThumbKey(fullresKey);
        return {
            id: slug,
            videoUrl: toCdnUrl(fullresKey),
            thumbUrl: toCdnUrl(thumbKey)
        };
    });

    const hasMore = end < videoSlugs.length;
    const response: VideosResponse = {
        items,
        page,
        pageSize,
        hasMore,
        nextPage: hasMore ? page + 1 : null,
        total: videoSlugs.length
    };

    return json(response, {
        headers: {
            // Avoid caching mock pagination results in dev.
            'cache-control': 'no-store'
        }
    });
};
