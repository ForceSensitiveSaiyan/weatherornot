import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createDecipheriv, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { openDb } from '../src/db.js';
import { createGame } from '../src/game.js';
import { mockGeocoder } from '../src/places.js';
import { checkSubscription, encrypt, vapidHeader, vapidKeys, webPush } from '../src/push.js';
import { createNotifier } from '../src/notify.js';

const LONDON = 'gn:2643743';
const mild = { tmax: 17.8, tmin: 9, precip: 3.2, snow: 0, gust: 41, code: 61 };

// A browser's side of a subscription: its keys, and how it reads a message.
function browser(endpoint = 'https://fcm.googleapis.com/fcm/send/abc123') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const sub = { endpoint, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: auth.toString('base64url') } };
  const read = (body) => {
    const salt = body.subarray(0, 16);
    const idLen = body[20];
    const asPublic = body.subarray(21, 21 + idLen);
    const shared = ecdh.computeSecret(asPublic);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
    const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const data = body.subarray(21 + idLen);
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(data.subarray(-16));
    const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
    assert.equal(plain.at(-1), 2, 'last-record delimiter');
    return JSON.parse(plain.subarray(0, -1));
  };
  return { sub, read };
}

test('messages are encrypted so only the subscribed browser can read them', () => {
  const { sub, read } = browser();
  const body = encrypt(JSON.stringify({ title: '3/3 in Douglas' }), checkSubscription(sub));
  assert.equal(body.readUInt32BE(16), 4096);
  assert.deepEqual(read(body), { title: '3/3 in Douglas' });
  assert.throws(() => browser().read(body));
});

test('encryption matches the worked example in RFC 8291', () => {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
  const body = encrypt('When I grow up, I want to be a watermelon', {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  }, { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), ecdh });
  assert.equal(body.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('the VAPID token is signed by our key, for the push service it goes to', () => {
  const keys = { ...vapidKeys(), subject: 'mailto:hello@aidoo.biz' };
  const header = vapidHeader('https://web.push.apple.com/abc', keys, Date.parse('2026-10-07T07:30:00Z'));
  const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, keys.publicKey);
  const [head, claims, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')),
    { aud: 'https://web.push.apple.com', exp: Date.parse('2026-10-07T19:30:00Z') / 1000, sub: 'mailto:hello@aidoo.biz' });
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('only real push services are accepted as endpoints', () => {
  const ok = (endpoint) => checkSubscription(browser(endpoint).sub) != null;
  assert.ok(ok('https://fcm.googleapis.com/fcm/send/x'));
  assert.ok(ok('https://updates.push.services.mozilla.com/wpush/v2/x'));
  assert.ok(ok('https://wns2-db5p.notify.windows.com/w/?token=x'));
  assert.ok(ok('https://web.push.apple.com/x'));
  assert.ok(!ok('http://fcm.googleapis.com/x'));
  assert.ok(!ok('https://fcm.googleapis.com:8443/x'));
  assert.ok(!ok('https://169.254.169.254/latest'));
  assert.ok(!ok('https://fcm.googleapis.com.evil.example/x'));
  assert.equal(checkSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'AAAA', auth: 'BBBB' } }), null);
  assert.equal(checkSubscription(null), null);
});

test('without keys there are no notifications', () => {
  assert.equal(webPush({ env: {} }), null);
});

test('results go out once, after 7.30 the next morning, to players who turned them on', async () => {
  const clock = { now: new Date('2026-10-05T12:00:00Z') };
  const weather = new Map([['2026-10-05', mild], ['2026-10-06', mild], ['2026-10-07', mild]]);
  const db = openDb();
  const game = createGame({ db, provider: { daily: async () => weather }, geocoder: mockGeocoder(), now: () => clock.now });
  const sent = [];
  let reply = 'sent';
  const push = { publicKey: 'k', send: async (sub, message) => (sent.push({ sub, message }), reply) };
  const notifier = createNotifier({ db, push, now: () => clock.now });

  const player = () => game.userForToken(game.createGuest());
  const ann = player();
  const ben = player();
  const { round } = await game.view(null, LONDON);
  for (const key of ['rain', 'temp', 'wind']) {
    game.makePick(ann.id, round.id, key, key === 'rain' ? 1 : 0);
    game.makePick(ben.id, round.id, key, 1);
  }
  const phone = browser();
  notifier.subscribe(ann.id, phone.sub);
  assert.throws(() => notifier.subscribe(ann.id, { endpoint: 'https://example.com/x', keys: phone.sub.keys }), /can't do notifications/);

  clock.now = new Date('2026-10-07T01:30:00Z'); // 2.30am in London: settled, but too early to buzz
  weather.set('2026-10-06', { ...mild, tmax: 15.5, precip: 6, gust: 35 });
  assert.equal(await game.settleRounds(), 1);
  assert.equal(await notifier.morning(), 0);

  clock.now = new Date('2026-10-07T06:31:00Z'); // 7.31am
  assert.equal(await notifier.morning(), 1);
  assert.equal(sent.length, 1, 'Ben has notifications off');
  assert.deepEqual(sent[0].message, {
    title: 'You called it. 3/3 in London',
    body: 'Forecast model estimate: 6 mm of rain, 15.5°C, gusts 22 mph. Same as the forecast.',
    tag: `results-${round.id}`,
    url: '/?from=push',
  });
  assert.equal(await notifier.morning(), 0, 'once only');

  // The phone was unsubscribed in the meantime: the push service says it's gone, so we forget it.
  notifier.subscribe(ben.id, browser('https://web.push.apple.com/ben').sub);
  db.prepare('DELETE FROM push_sent').run();
  reply = 'gone';
  await notifier.morning();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n, 0);
});

test('a result that settles days late is never sent', async () => {
  const clock = { now: new Date('2026-10-05T12:00:00Z') };
  const weather = new Map([['2026-10-05', mild], ['2026-10-06', mild]]);
  const db = openDb();
  const game = createGame({ db, provider: { daily: async () => weather }, geocoder: mockGeocoder(), now: () => clock.now });
  const sent = [];
  const notifier = createNotifier({ db, push: { publicKey: 'k', send: async (s, m) => (sent.push(m), 'sent') }, now: () => clock.now });
  const ann = game.userForToken(game.createGuest());
  const { round } = await game.view(null, LONDON);
  game.makePick(ann.id, round.id, 'rain', 1);
  notifier.subscribe(ann.id, browser().sub);
  clock.now = new Date('2026-10-08T09:00:00Z');
  await game.settleRounds();
  assert.equal(await notifier.morning(), 0);
  assert.equal(sent.length, 0);
});
