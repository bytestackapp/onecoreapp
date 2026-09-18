// Shared by both Edge Functions. Handles:
//   1. Exchanging a Firebase service account key for a short-lived OAuth2
//      access token (FCM's current API requires this — the old "server
//      key" HTTP API was shut down by Google in 2024).
//   2. Sending a single push message via FCM's HTTP v1 API.
//
// Runs on Deno (Supabase Edge Functions), using the platform's built-in
// Web Crypto API — no external auth library needed.

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

function base64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let str = "";
  bytes.forEach((b) => (str += String.fromCharCode(b)));
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const contents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binary = atob(contents);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

/** Exchanges a Firebase service-account JSON for a short-lived FCM access token. */
export async function getAccessToken(serviceAccount: ServiceAccount): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const key = await importPrivateKey(serviceAccount.private_key);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to get FCM access token: ${res.status} ${await res.text()}`);
  }
  const { access_token } = await res.json();
  return access_token;
}

export interface PushResult {
  token: string;
  ok: boolean;
  shouldDelete: boolean; // true when FCM says the token is dead (uninstalled, expired, etc.)
}

/** Sends one push message to one device token via FCM HTTP v1. */
export async function sendPush(
  accessToken: string,
  projectId: string,
  token: string,
  title: string,
  body: string,
  data: Record<string, string> = {}
): Promise<PushResult> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        data,
        android: { priority: "high", notification: { sound: "default", channel_id: "default" } },
        apns: { payload: { aps: { sound: "default" } } },
      },
    }),
  });

  if (res.ok) return { token, ok: true, shouldDelete: false };

  const errText = await res.text();
  console.error(`FCM send failed for token ${token}: ${res.status} ${errText}`);
  // UNREGISTERED / NOT_FOUND means the app was uninstalled or the token
  // rotated — safe to remove so we stop retrying it forever.
  const shouldDelete = res.status === 404 || errText.includes("UNREGISTERED") || errText.includes("NOT_FOUND");
  return { token, ok: false, shouldDelete };
}

export function loadServiceAccount(): ServiceAccount {
  const raw = Deno.env.get("FCM_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("FCM_SERVICE_ACCOUNT_JSON secret is not set.");
  return JSON.parse(raw);
}
