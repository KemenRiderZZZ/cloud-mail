import { describe, expect, it, vi } from 'vitest';
import {
	exportApplicationServerKey,
	exportVapidKeys,
	generateVapidKeys,
} from '@negrel/webpush';
import {
	buildPushPayload,
	createSessionTokenIdentifier,
	getPushConfig,
	normalizePushSubscription,
	sendPushToUser,
	sendPushToUserSafely,
} from '../src/service/push-service';

async function vapidSecret() {
	const keys = await generateVapidKeys({ extractable: true });
	return { secret: JSON.stringify(await exportVapidKeys(keys)), publicKey: await exportApplicationServerKey(keys) };
}

function base64Url(bytes) {
	return Buffer.from(bytes).toString('base64url');
}

async function browserSubscription(endpoint = 'https://fcm.googleapis.com/fcm/send/abc') {
	const keys = await crypto.subtle.generateKey(
		{name: 'ECDH', namedCurve: 'P-256'},
		true,
		['deriveBits'],
	);
	return {
		endpoint,
		expirationTime: null,
		keys: {
			p256dh: base64Url(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))),
			auth: base64Url(crypto.getRandomValues(new Uint8Array(16))),
		},
	};
}

function pushEnv({ secret, rows = [], tokens = ['session-token'], run = vi.fn(async () => ({})) }) {
	return {
		VAPID_PRIVATE_KEY: secret,
		admin: 'admin@example.com',
		kv: { get: vi.fn(async () => ({ tokens })) },
		db: {
			prepare: vi.fn(sql => ({
				bind() { return this; },
				all: vi.fn(async () => ({ results: rows })),
				run: vi.fn(async () => run(sql)),
			})),
		},
	};
}

describe('push subscription validation', () => {
	it('accepts a browser subscription and rejects unsafe endpoints', async () => {
		const input = await browserSubscription();
		expect(normalizePushSubscription(input)).toEqual({
			endpoint: input.endpoint,
			expirationTime: null,
			p256dh: input.keys.p256dh,
			auth: input.keys.auth,
		});
		expect(() => normalizePushSubscription({ ...input, endpoint: 'http://localhost/push' })).toThrow();
		expect(() => normalizePushSubscription({ ...input, endpoint: 'https://192.168.1.1/push' })).toThrow();
	});

	it('shows sender, subject and a safe plain-text message preview', () => {
		const payload = buildPushPayload({
			emailId: 42,
			name: 'Sender',
			subject: 'Subject',
			text: 'First line\nSecond line',
			content: '<script>alert("not notification content")</script>',
		});
		expect(payload).toMatchObject({
			emailId: 42,
			title: 'Sender',
			body: 'Subject\nFirst line Second line',
			url: '/inbox',
		});
		expect(JSON.stringify(payload)).not.toContain('not notification content');
	});
});

describe('push configuration and delivery isolation', () => {
	it('derives the public application server key without exposing the private JWK', async () => {
		const generated = await vapidSecret();
		const config = await getPushConfig(pushEnv({secret: generated.secret}));
		expect(config.enabled).toBe(true);
		expect(config.publicKey).toBe(generated.publicKey);
		expect(JSON.stringify(config)).not.toContain('privateKey');
	});

	it('delivers only to subscriptions belonging to active login sessions', async () => {
		const generated = await vapidSecret();
		const activeIdentifier = await createSessionTokenIdentifier('session-token');
		const rows = [
			{endpoint: 'https://push.example/active', p256dh: 'a', auth: 'b', session_token: activeIdentifier},
			{endpoint: 'https://push.example/old', p256dh: 'c', auth: 'd', session_token: 'logged-out'},
		];
		const send = vi.fn(async () => {});
		await expect(sendPushToUser(
			pushEnv({secret: generated.secret, rows}),
			7,
			{emailId: 10, name: 'Sender', subject: 'Subject'},
			send,
		)).resolves.toEqual({delivered: 1, failed: 0});
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0][0].endpoint).toContain('/active');
	});

	it('builds and sends an RFC 8291 encrypted request with Web Crypto', async () => {
		const generated = await vapidSecret();
		const subscription = await browserSubscription();
		const activeIdentifier = await createSessionTokenIdentifier('session-token');
		const rows = [{
			endpoint: subscription.endpoint,
			p256dh: subscription.keys.p256dh,
			auth: subscription.keys.auth,
			session_token: activeIdentifier,
		}];
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn(async () => new Response(null, {status: 201}));
		globalThis.fetch = fetchMock;
		try {
			await expect(sendPushToUser(
				pushEnv({secret: generated.secret, rows}),
				7,
				{emailId: 10, name: 'Sender', subject: 'Subject'},
			)).resolves.toEqual({delivered: 1, failed: 0});
		} finally {
			globalThis.fetch = originalFetch;
		}
		const [, init] = fetchMock.mock.calls[0];
		expect(init.headers['Content-Encoding']).toBe('aes128gcm');
		expect(init.headers.Authorization).toMatch(/^vapid /);
		expect(init.body.byteLength).toBeGreaterThan(0);
	});

	it('never propagates storage or delivery failures into mail persistence', async () => {
		const env = {
			kv: {get: vi.fn(async () => ({tokens: ['session-token']}))},
			db: {prepare: vi.fn(() => ({bind() { return this; }, all: async () => { throw new Error('D1 unavailable'); }}))},
		};
		await expect(sendPushToUserSafely(env, 7, {emailId: 10})).resolves.toEqual({delivered: 0, failed: 1});
	});
});
