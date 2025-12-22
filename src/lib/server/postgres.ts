import { env } from '$env/dynamic/private';
import { error } from '@sveltejs/kit';
import pg from 'pg';

const { Pool } = pg;

type SslMode = 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';

const readRequiredEnv = (name: string): string => {
    const value = env[name];
    if (!value) throw error(500, `Missing environment variable: ${name}`);
    return value;
};

const readOptionalEnv = (name: string): string | undefined => {
    const value = env[name];
    return value && value.length > 0 ? value : undefined;
};

const parsePort = (value: string | undefined): number => {
    if (!value) return 5432;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
        throw error(500, `Invalid POSTGRES_PORT: ${value}`);
    }
    return parsed;
};

const normalizeCa = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    // Support CA values injected with literal \n sequences.
    return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
};

const parseSslMode = (value: string | undefined): SslMode => {
    const mode = (value ?? 'disable').toLowerCase();
    switch (mode) {
        case 'disable':
        case 'allow':
        case 'prefer':
        case 'require':
        case 'verify-ca':
        case 'verify-full':
            return mode;
        default:
            throw error(
                500,
                `Invalid POSTGRES_SSLMODE: ${value ?? ''} (expected disable|allow|prefer|require|verify-ca|verify-full)`
            );
    }
};

const getPgSslConfig = (sslmode: SslMode, ca: string | undefined) => {
    // For node-postgres:
    // - ssl: false disables TLS.
    // - ssl: { rejectUnauthorized, ca } configures TLS verification.
    //
    // Match libpq sslmode semantics:
    // - require: encrypt but do not verify server cert
    // - verify-ca/verify-full: verify server cert using provided CA
    // Note: pg doesn't support opportunistic fallback (prefer/allow) like libpq.
    if (sslmode === 'disable') return false;
    if (sslmode === 'allow' || sslmode === 'prefer' || sslmode === 'require') {
        return ca ? { rejectUnauthorized: false, ca } : { rejectUnauthorized: false };
    }

    // verify-ca / verify-full
    if (!ca) {
        throw error(500, `POSTGRES_CA is required when POSTGRES_SSLMODE is ${sslmode}`);
    }

    return { rejectUnauthorized: true, ca };
};

let pool: pg.Pool | undefined;
let initPromise: Promise<pg.Pool> | undefined;

export const initPostgres = async (): Promise<pg.Pool> => {
    if (pool) return pool;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        const host = readRequiredEnv('POSTGRES_HOST');
        const port = parsePort(readOptionalEnv('POSTGRES_PORT'));
        const database = readRequiredEnv('POSTGRES_DATABASE');
        const user = readRequiredEnv('POSTGRES_USERNAME');
        const password = readOptionalEnv('POSTGRES_PASSWORD');

        const sslmode = parseSslMode(readOptionalEnv('POSTGRES_SSLMODE'));
        const ca = normalizeCa(readOptionalEnv('POSTGRES_CA'));

        const created = new Pool({
            host,
            port,
            database,
            user,
            password,
            ssl: getPgSslConfig(sslmode, ca)
        });

        // Force an initial connection attempt at server startup.
        await created.query('select 1');

        pool = created;
        return created;
    })();

    return initPromise;
};

export const getPostgresPool = (): pg.Pool => {
    if (!pool) {
        throw error(500, 'Postgres not initialized. Call initPostgres() on server startup.');
    }
    return pool;
};
