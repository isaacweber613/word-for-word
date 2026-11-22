/**
 * Checks a Google Play purchase with the Android Publisher API, so a phone can't claim a
 * subscription it didn't buy. Signs in as the service account in the secret
 * GOOGLE_SERVICE_ACCOUNT (its JSON key file), which Play Console must allow to view orders.
 */

export const PACKAGE = "com.isaacweber.wordforword";
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/" + PACKAGE + "/purchases";

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }

const PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const INTEGRITY_SCOPE = "https://www.googleapis.com/auth/playintegrity";
const cached = new Map<string, { token: string; until: number }>();

function b64url(data: ArrayBuffer | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function accessToken(json: string, scope: string, fetcher: typeof fetch, now: number): Promise<string> {
  const hit = cached.get(scope);
  if (hit && hit.until > now + 60_000) return hit.token;
  const sa = JSON.parse(json) as ServiceAccount;
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const iat = Math.floor(now / 1000);
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const unsigned = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64url(JSON.stringify({
    iss: sa.client_email, scope, aud: tokenUri, iat, exp: iat + 3600,
  }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetcher(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + unsigned + "." + b64url(signature),
  });
  if (!res.ok) throw new Error("Google sign-in failed: " + res.status);
  const body = await res.json() as { access_token: string; expires_in: number };
  cached.set(scope, { token: body.access_token, until: now + body.expires_in * 1000 });
  return body.access_token;
}

export type Verified =
  | { kind: "subscription"; product: string; expiry: number }
  | { kind: "product"; product: string }
  | null;

/**
 * Asks Google about [token]. A subscription that is active (or in its grace period) gives the
 * end of its paid month; a one-time product counts only once it's paid. Anything else is null.
 */
export async function verify(serviceAccount: string, product: string, token: string, subscription: boolean,
                             fetcher: typeof fetch, now: number): Promise<Verified> {
  const auth = { Authorization: "Bearer " + await accessToken(serviceAccount, PUBLISHER_SCOPE, fetcher, now) };
  if (subscription) {
    const res = await fetcher(API + "/subscriptionsv2/tokens/" + encodeURIComponent(token), { headers: auth });
    if (!res.ok) return refused(res, serviceAccount);
    const s = await res.json() as { subscriptionState?: string; lineItems?: { productId?: string; expiryTime?: string }[] };
    if (s.subscriptionState !== "SUBSCRIPTION_STATE_ACTIVE" && s.subscriptionState !== "SUBSCRIPTION_STATE_IN_GRACE_PERIOD") return null;
    const item = s.lineItems?.find((i) => i.productId === product) ?? s.lineItems?.[0];
    const expiry = Date.parse(item?.expiryTime ?? "");
    return Number.isFinite(expiry) ? { kind: "subscription", product: item?.productId ?? product, expiry } : null;
  }
  const res = await fetcher(API + "/products/" + encodeURIComponent(product) + "/tokens/" + encodeURIComponent(token), { headers: auth });
  if (!res.ok) return refused(res, serviceAccount);
  const p = await res.json() as { purchaseState?: number };
  return p.purchaseState === 0 ? { kind: "product", product } : null;
}

/**
 * Google said no. An unknown token is not paid (null); Google refusing this server (401, 403) or
 * failing (5xx) throws, so the app is told to try again instead of being told it didn't pay.
 */
async function refused(res: Response, serviceAccount: string): Promise<null> {
  const text = (await res.text()).slice(0, 300);
  let who = "";
  try { who = (JSON.parse(serviceAccount) as ServiceAccount).client_email; } catch { /* unreadable key */ }
  console.error("Google Play purchase check", res.status, who, text);
  if (res.status === 401 || res.status === 403 || res.status >= 500) throw new Error("Google answered " + res.status);
  return null;
}

/** The parts of a decoded Play Integrity verdict this server checks. */
export interface IntegrityPayload {
  requestDetails?: { requestPackageName?: string; requestHash?: string; timestampMillis?: string };
  appIntegrity?: { appRecognitionVerdict?: string; packageName?: string };
  deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
}

/**
 * Has Google decrypt a Play Integrity token the app sent (developer.android.com/google/play/integrity/standard).
 * Null when Google says the token itself is bad (400); throws when Google refuses this server or fails.
 */
export async function decodeIntegrity(serviceAccount: string, token: string, fetcher: typeof fetch,
                                      now: number): Promise<IntegrityPayload | null> {
  const res = await fetcher("https://playintegrity.googleapis.com/v1/" + PACKAGE + ":decodeIntegrityToken", {
    method: "POST",
    headers: { Authorization: "Bearer " + await accessToken(serviceAccount, INTEGRITY_SCOPE, fetcher, now),
      "Content-Type": "application/json" },
    body: JSON.stringify({ integrity_token: token }),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    console.error("Play Integrity decode", res.status, text);
    if (res.status === 400) return null;
    throw new Error("Google answered " + res.status);
  }
  return ((await res.json()) as { tokenPayloadExternal?: IntegrityPayload }).tokenPayloadExternal ?? null;
}
