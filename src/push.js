// Web push without a library: VAPID (RFC 8292) to say who's sending, and
// aes128gcm (RFC 8291) to encrypt the message so only that browser can read it.
import { createECDH, createPrivateKey, createCipheriv, hkdfSync, randomBytes, sign } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

// Browsers' push services. We only ever post to these, so a made-up
// "subscription" can't point the server at anything else.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, // Chrome, Edge on Android, Samsung
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^[a-z0-9-]+\.notify\.windows\.com$/, // Edge on Windows
  /^web\.push\.apple\.com$/, // Safari, and the iPhone home-screen app
];

// A subscription as the browser gives it, checked and trimmed to what we keep.
export function checkSubscription(sub) {
  const endpoint = String(sub?.endpoint ?? '');
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port || endpoint.length > 1000 || !PUSH_HOSTS.some((h) => h.test(url.hostname))) return null;
  const p256dh = fromB64u(sub?.keys?.p256dh ?? '');
  const auth = fromB64u(sub?.keys?.auth ?? '');
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) return null;
  return { endpoint, p256dh: b64u(p256dh), auth: b64u(auth) };
}

// A new key pair for VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.
export function vapidKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

// The message encrypted for one browser: the request body.
export function encrypt(payload, { p256dh, auth }, { salt = randomBytes(16), ecdh = null } = {}) {
  const uaPublic = fromB64u(p256dh);
  if (!ecdh) {
    ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
  }
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, fromB64u(auth), keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // One record, so it ends with the last-record delimiter (2).
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// Signs a short-lived token saying this server is allowed to push to the
// endpoint's service.
export function vapidHeader(endpoint, { publicKey, privateKey, subject }, nowMs = Date.now()) {
  const pub = fromB64u(publicKey);
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)), d: privateKey },
    format: 'jwk',
  });
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject }));
  const signature = sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(signature)}, k=${publicKey}`;
}

// A sender from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or null when they're
// not set (the game then just doesn't offer notifications).
// send(sub, message) resolves to 'sent', 'gone' (unsubscribed: forget it) or 'failed'.
export function webPush({ env = process.env, fetchFn = fetch } = {}) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  const keys = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || 'mailto:hello@aidoo.biz' };
  vapidHeader('https://fcm.googleapis.com/x', keys); // fail at startup, not at 7.30am, if the keys are wrong
  return {
    publicKey: keys.publicKey,
    async send(sub, message) {
      try {
        const res = await fetchFn(sub.endpoint, {
          method: 'POST',
          headers: {
            Authorization: vapidHeader(sub.endpoint, keys),
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: String(6 * 3600), // a phone that's off until lunch still gets it
            Urgency: 'normal',
          },
          body: encrypt(JSON.stringify(message), sub),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 404 || res.status === 410) return 'gone';
        if (!res.ok) console.error(`Push to ${new URL(sub.endpoint).hostname} failed: ${res.status}`);
        return res.ok ? 'sent' : 'failed';
      } catch (err) {
        console.error('Push failed:', err.message);
        return 'failed';
      }
    },
  };
}
