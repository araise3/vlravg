// Verifies a GitHub Actions OIDC token (docs/replay-import.md#flow): a JWT
// GitHub signs for one job of one workflow run. The replay parse job holds no
// secrets; with `id-token: write` it can still prove "I am the parse job of
// run N of parse-replays.yml on main", and the Function serves it the raw files
// that run claimed, once each.
//
// Only RS256 with a key from GitHub's JWKS is accepted. Keys are cached per
// isolate; an unknown key ID refetches them once.

export const ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';
export const RAW_AUDIENCE = 'vlravg-replay-raw';
const JWKS_URL = `${ACTIONS_ISSUER}/.well-known/jwks`;
const SKEW_S = 60;

let cachedKeys = null;

const b64url = text => {
  const base = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base + '='.repeat((4 - base.length % 4) % 4)), c => c.charCodeAt(0));
};
const decodeJson = part => JSON.parse(new TextDecoder().decode(b64url(part)));

async function keys(env, refresh) {
  // Tests (and a pinned deployment) may supply the key set directly.
  if (env.REPLAY_OIDC_JWKS) return JSON.parse(env.REPLAY_OIDC_JWKS).keys || [];
  if (!cachedKeys || refresh) {
    const res = await fetch(JWKS_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`jwks ${res.status}`);
    cachedKeys = (await res.json()).keys || [];
  }
  return cachedKeys;
}

// The claims of a valid token for `audience`, or null.
export async function verifyActionsToken(token, env, { audience = RAW_AUDIENCE, nowS = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof token !== 'string' || token.length > 8192) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(p => !/^[\w-]+$/.test(p))) return null;
  let header, claims;
  try { header = decodeJson(parts[0]); claims = decodeJson(parts[1]); } catch { return null; }
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string') return null;
  let jwk = (await keys(env, false)).find(k => k.kid === header.kid);
  if (!jwk && !env.REPLAY_OIDC_JWKS) jwk = (await keys(env, true)).find(k => k.kid === header.kid);
  if (!jwk || jwk.kty !== 'RSA') return null;
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), signed)) return null;
  if (claims?.iss !== ACTIONS_ISSUER) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) return null;
  if (!Number.isFinite(claims.exp) || claims.exp + SKEW_S < nowS) return null;
  if (Number.isFinite(claims.nbf) && claims.nbf - SKEW_S > nowS) return null;
  return claims;
}

// Whether the token is the replay parse job of `repository`'s main branch.
export function isParseJob(claims, repository) {
  return !!claims && claims.repository === repository
    && claims.job_workflow_ref === `${repository}/.github/workflows/parse-replays.yml@refs/heads/main`
    && /^\d{1,20}$/.test(String(claims.run_id || ''));
}
