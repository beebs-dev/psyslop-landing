CREATE TABLE IF NOT EXISTS home_hits (
    id UUID PRIMARY KEY,
    ip_address TEXT NOT NULL,
    useragent TEXT NOT NULL,
    timestamp BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS video_hits (
    id UUID PRIMARY KEY,
    video_id TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    useragent TEXT NOT NULL,
    timestamp BIGINT NOT NULL
);