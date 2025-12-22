type HitCounters = {
    homeHitsTotal: number;
    videoHitsTotal: number;
};

const counters: HitCounters = {
    homeHitsTotal: 0,
    videoHitsTotal: 0
};

export const incrementHomeHit = () => {
    counters.homeHitsTotal += 1;
};

export const incrementVideoHit = () => {
    counters.videoHitsTotal += 1;
};

export const getHitCounters = () => {
    // Return a copy to avoid accidental mutation.
    return {
        homeHitsTotal: counters.homeHitsTotal,
        videoHitsTotal: counters.videoHitsTotal
    };
};

export const renderPrometheusMetrics = () => {
    const { homeHitsTotal, videoHitsTotal } = getHitCounters();
    return [
        '# HELP home_hits_total Total home hits observed by this process.',
        '# TYPE home_hits_total counter',
        `home_hits_total ${homeHitsTotal}`,
        '# HELP video_hits_total Total video plays observed by this process.',
        '# TYPE video_hits_total counter',
        `video_hits_total ${videoHitsTotal}`,
        ''
    ].join('\n');
};
