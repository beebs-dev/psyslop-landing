type Key = string;

const homeHitsTotal = new Map<Key, number>();
const videoHitsTotal = new Map<Key, number>();

function inc(map: Map<Key, number>, key: Key, by = 1) {
    map.set(key, (map.get(key) ?? 0) + by);
}

// Example: bucket IP to /24 for IPv4 (very rough)
function ipBucket(ip: string): string {
    // naive: only IPv4 here; handle IPv6 separately in real code
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    return "other";
}

export function recordHomeHit({ videoId, ipAddress, useragent }: { videoId: string | null; ipAddress: string; useragent?: string }) {
    // Keep labels bounded. Consider omitting ipBucket entirely.
    let key = `route="/",ip_bucket="${ipBucket(ipAddress)}",useragent="${useragent ?? "unknown"}"`;
    if (videoId) {
        key += `,video_id="${videoId}"`;
    }
    inc(homeHitsTotal, key);
}

export function recordVideoHit({ videoId, ipAddress, useragent }: { videoId: string | null; ipAddress: string; useragent?: string }) {
    const vid = videoId ?? "none";
    const key = `video_id="${vid}",ip_bucket="${ipBucket(ipAddress)}",useragent="${useragent ?? "unknown"}"`;
    inc(videoHitsTotal, key);
}

function renderMapAsCounterLines(
    metric: string,
    help: string,
    map: Map<Key, number>
) {
    const lines: string[] = [];
    lines.push(`# HELP ${metric} ${help}`);
    lines.push(`# TYPE ${metric} counter`);
    for (const [labelset, value] of map.entries()) {
        lines.push(`${metric}{${labelset}} ${value}`);
    }
    return lines.join("\n");
}

export function renderPrometheusMetrics() {
    // IMPORTANT: do NOT clear totals; counters should keep increasing.
    // If you need "since last scrape", use a gauge or separate *_interval counter
    // with clear-on-scrape (but understand it’s lossy).
    return [
        renderMapAsCounterLines(
            "home_hits_total",
            "Total hits to home route",
            homeHitsTotal
        ),
        renderMapAsCounterLines(
            "video_hits_total",
            "Total video hits",
            videoHitsTotal
        ),
    ].join("\n\n") + "\n";
}
