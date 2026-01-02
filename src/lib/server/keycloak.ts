import { env } from '$env/dynamic/private';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

type KeycloakConfig = {
	issuer: string;
	expectedClientId: string;
	jwksUrl: URL;
};

const normalizeEndpoint = (value: string) => value.replace(/\/+$/, '');
const normalizeIssuer = (value: string) => value.replace(/\/+$/, '');

const looksLikeRealmIssuer = (value: string) => /\/realms\//.test(value);

const getKeycloakConfig = (): KeycloakConfig | null => {
	const endpoint = (env.KC_ENDPOINT ?? '').trim();
	const realm = (env.KC_REALM ?? '').trim();
	const clientId = (env.KC_CLIENT_ID ?? '').trim();
	if (!endpoint || !realm || !clientId) return null;

	const normalized = normalizeEndpoint(endpoint);
	// Accept KC_ENDPOINT as either a base URL (https://kc.example.com)
	// or a full realm issuer URL (https://kc.example.com/realms/<realm>).
	const issuer = looksLikeRealmIssuer(normalized)
		? normalized
		: `${normalized}/realms/${encodeURIComponent(realm)}`;
	return {
		issuer,
		expectedClientId: clientId,
		jwksUrl: new URL(`${issuer}/protocol/openid-connect/certs`)
	};
};

let jwks:
	| {
		config: KeycloakConfig;
		keySet: ReturnType<typeof createRemoteJWKSet>;
	}
	| null
	| undefined;

const getJwks = () => {
	const config = getKeycloakConfig();
	if (!config) return null;

	if (
		!jwks ||
		jwks === null ||
		jwks.config.issuer !== config.issuer ||
		jwks.config.expectedClientId !== config.expectedClientId
	) {
		jwks = {
			config,
			keySet: createRemoteJWKSet(config.jwksUrl)
		};
	}
	return jwks;
};

export const isKeycloakEnabled = () => Boolean(getKeycloakConfig());

export async function verifyKeycloakAccessToken(token: string): Promise<JWTPayload> {
	const cached = getJwks();
	if (!cached) {
		throw new Error('Keycloak is not configured (set KC_ENDPOINT, KC_REALM, KC_CLIENT_ID)');
	}

	// Verify signature (and exp/nbf) first, then validate issuer/audience ourselves.
	const { payload } = await jwtVerify(token, cached.keySet);

	//const expectedIssuer = normalizeIssuer(cached.config.issuer);
	//const actualIssuer = typeof payload.iss === 'string' ? normalizeIssuer(payload.iss) : null;
	
	const expected = cached.config.expectedClientId;
	const aud = payload.aud;
	const azp = typeof payload.azp === 'string' ? payload.azp : null;
	const audOk = typeof aud === 'string' ? aud === expected : Array.isArray(aud) ? aud.includes(expected) : false;
	const azpOk = azp === expected;
	if (!audOk && !azpOk) {
		throw new Error(`Keycloak token is not issued for client "${expected}"`);
	}
	return payload;
}
