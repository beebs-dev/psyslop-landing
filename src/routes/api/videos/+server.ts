import { env } from '$env/dynamic/private';
import { error, json, type RequestHandler } from '@sveltejs/kit';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

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
        mp4Keys: string[];
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
    const entries: Array<{ key: string; lastModifiedMs: number }> = [];

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
            if (!obj.Key.toLowerCase().endsWith('.mp4')) continue;
            entries.push({
                key: obj.Key,
                lastModifiedMs: obj.LastModified ? obj.LastModified.getTime() : 0
            });
        }

        if (!res.IsTruncated) break;
        continuationToken = res.NextContinuationToken;
        if (!continuationToken) break;
    }

    // S3 doesn't expose a true "creation date" via ListObjects; LastModified is the closest available.
    // Most recent first.
    entries.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs || a.key.localeCompare(b.key));
    return entries.map((e) => e.key);
};

const getCachedMp4Keys = async (): Promise<string[]> => {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.mp4Keys;

    // If we have stale cache, try to refresh quickly; if refresh is slow/fails, serve stale.
    if (cache) {
        try {
            const refreshed = await withTimeout(
                listAllMp4Keys(),
                REFRESH_TIMEOUT_MS,
                `Spaces refresh timed out after ${REFRESH_TIMEOUT_MS}ms`
            );
            cache = { fetchedAt: now, mp4Keys: refreshed };
            return refreshed;
        } catch {
            // Avoid retrying refresh on every request when Spaces is slow/unreachable.
            cache = { fetchedAt: now, mp4Keys: cache.mp4Keys };
            return cache.mp4Keys;
        }
    }

    const mp4Keys = await withTimeout(
        listAllMp4Keys(),
        REFRESH_TIMEOUT_MS,
        `Spaces refresh timed out after ${REFRESH_TIMEOUT_MS}ms`
    );
    cache = { fetchedAt: now, mp4Keys };
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

export const GET: RequestHandler = async ({ url }) => {
    // Simple offset-pagination for now. Replace with cursor-based pagination later if desired.
    const page = clampInt(url.searchParams.get('page'), 1, 1, 10_000);
    const pageSize = clampInt(url.searchParams.get('pageSize'), 12, 1, 48);
    const mp4Keys = await getCachedMp4Keys();

    const start = (page - 1) * pageSize;
    const end = Math.min(start + pageSize, mp4Keys.length);

    const slice = mp4Keys.slice(start, end);
    const items: VideoItem[] = slice.map((key) => {
        const thumbKey = toThumbKey(key);
        return {
            id: key,
            videoUrl: toCdnUrl(key),
            thumbUrl: toCdnUrl(thumbKey)
        };
    });

    const hasMore = end < mp4Keys.length;
    const response: VideosResponse = {
        items,
        page,
        pageSize,
        hasMore,
        nextPage: hasMore ? page + 1 : null,
        total: mp4Keys.length
    };

    return json(response, {
        headers: {
            // Avoid caching mock pagination results in dev.
            'cache-control': 'no-store'
        }
    });
};
