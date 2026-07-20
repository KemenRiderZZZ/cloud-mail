import {
	ApplicationServer,
	PushMessageError,
	Urgency,
	exportApplicationServerKey,
	importVapidKeys,
} from '@negrel/webpush';
import KvConst from '../const/kv-const';

export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 5;
export const PUSH_PAYLOAD_MAX_LENGTH = 240;
export const PUSH_PREVIEW_MAX_LENGTH = 160;

const PUSH_CONCURRENCY = 4;
const PUSH_TTL_SECONDS = 5 * 60;
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_P256DH_LENGTH = 512;
const MAX_AUTH_LENGTH = 128;

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function parseVapidSecret(env) {
	if (!env.VAPID_PRIVATE_KEY) {
		throw new Error('VAPID_PRIVATE_KEY is not configured');
	}

	let value;
	try {
		value = JSON.parse(env.VAPID_PRIVATE_KEY);
	} catch {
		throw new Error('VAPID_PRIVATE_KEY is not valid JSON');
	}

	if (!value?.publicKey || !value?.privateKey) {
		throw new Error('VAPID_PRIVATE_KEY must contain publicKey and privateKey JWK values');
	}
	return value;
}

async function createApplicationServer(env) {
	const vapidKeys = await importVapidKeys(parseVapidSecret(env));
	const contact = String(env.admin || '').includes('@')
		? `mailto:${env.admin}`
		: 'https://mail.kamenr.com';
	return {
		applicationServer: await ApplicationServer.new({
			contactInformation: contact,
			vapidKeys,
		}),
		vapidKeys,
	};
}

export async function createSessionTokenIdentifier(sessionToken) {
	if (typeof sessionToken !== 'string' || !sessionToken) {
		throw new TypeError('Invalid login session');
	}
	const digest = new Uint8Array(await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(sessionToken),
	));
	let binary = '';
	for (const byte of digest) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isPrivateHostname(hostname) {
	const normalized = hostname.toLowerCase();
	if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) return true;
	const ipv6 = normalized.replace(/^\[|\]$/g, '');
	if (ipv6.includes(':')) {
		return ipv6 === '::1'
			|| ipv6.startsWith('fc')
			|| ipv6.startsWith('fd')
			|| /^fe[89ab]/.test(ipv6);
	}

	const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!ipv4) return false;
	const octets = ipv4.slice(1).map(Number);
	if (octets.some(value => value > 255)) return true;
	return octets[0] === 10
		|| octets[0] === 0
		|| octets[0] === 127
		|| (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
		|| (octets[0] === 169 && octets[1] === 254)
		|| (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
		|| (octets[0] === 192 && octets[1] === 168);
}

function decodeBase64Url(value) {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('Invalid push subscription keys');
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
	const binary = atob(base64);
	return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function normalizePushSubscription(input) {
	const endpoint = typeof input?.endpoint === 'string' ? input.endpoint.trim() : '';
	const p256dh = typeof input?.keys?.p256dh === 'string' ? input.keys.p256dh.trim() : '';
	const auth = typeof input?.keys?.auth === 'string' ? input.keys.auth.trim() : '';

	if (!endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) {
		throw new TypeError('Invalid push subscription endpoint');
	}

	let endpointUrl;
	try {
		endpointUrl = new URL(endpoint);
	} catch {
		throw new TypeError('Invalid push subscription endpoint');
	}

	if (endpointUrl.protocol !== 'https:' || isPrivateHostname(endpointUrl.hostname)) {
		throw new TypeError('Push subscription endpoint must be a public HTTPS URL');
	}
	if (!p256dh || p256dh.length > MAX_P256DH_LENGTH || !auth || auth.length > MAX_AUTH_LENGTH) {
		throw new TypeError('Invalid push subscription keys');
	}
	const publicKey = decodeBase64Url(p256dh);
	const authSecret = decodeBase64Url(auth);
	if (publicKey.length !== 65 || publicKey[0] !== 4 || authSecret.length !== 16) {
		throw new TypeError('Invalid push subscription keys');
	}

	const expirationTime = input.expirationTime == null ? null : Number(input.expirationTime);
	if (expirationTime != null && (!Number.isFinite(expirationTime) || expirationTime <= 0)) {
		throw new TypeError('Invalid push subscription expiration time');
	}

	return { endpoint, p256dh, auth, expirationTime };
}

export async function getPushConfig(env) {
	try {
		const { vapidKeys } = await createApplicationServer(env);
		return {
			enabled: true,
			publicKey: await exportApplicationServerKey(vapidKeys),
			maxDevices: MAX_PUSH_SUBSCRIPTIONS_PER_USER,
		};
	} catch (error) {
		console.warn(JSON.stringify({
			event: 'push.config.unavailable',
			error: errorMessage(error),
		}));
		return { enabled: false, publicKey: '', maxDevices: MAX_PUSH_SUBSCRIPTIONS_PER_USER };
	}
}

export async function savePushSubscription(env, userId, sessionToken, input, userAgent = '') {
	const normalizedUserId = Number(userId);
	if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) {
		throw new TypeError('Invalid user');
	}
	const subscription = normalizePushSubscription(input);
	const sessionIdentifier = await createSessionTokenIdentifier(sessionToken);
	const safeUserAgent = String(userAgent || '').slice(0, 512);

	await env.db.batch([
		env.db.prepare(`
			INSERT INTO push_subscription (user_id, session_token, endpoint, p256dh, auth, expiration_time, user_agent)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(endpoint) DO UPDATE SET
				user_id = excluded.user_id,
				session_token = excluded.session_token,
				p256dh = excluded.p256dh,
				auth = excluded.auth,
				expiration_time = excluded.expiration_time,
				user_agent = excluded.user_agent,
				update_time = CURRENT_TIMESTAMP
		`).bind(
			normalizedUserId,
			sessionIdentifier,
			subscription.endpoint,
			subscription.p256dh,
			subscription.auth,
			subscription.expirationTime,
			safeUserAgent,
		),
		env.db.prepare(`
			DELETE FROM push_subscription
			WHERE user_id = ?
			AND push_subscription_id NOT IN (
				SELECT push_subscription_id
				FROM push_subscription
				WHERE user_id = ?
				ORDER BY update_time DESC, push_subscription_id DESC
				LIMIT ?
			)
		`).bind(normalizedUserId, normalizedUserId, MAX_PUSH_SUBSCRIPTIONS_PER_USER),
	]);

	return { subscribed: true, maxDevices: MAX_PUSH_SUBSCRIPTIONS_PER_USER };
}

export async function deletePushSubscription(env, userId, endpoint) {
	const normalizedUserId = Number(userId);
	if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) {
		throw new TypeError('Invalid user');
	}
	if (typeof endpoint !== 'string' || !endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) {
		throw new TypeError('Invalid push subscription endpoint');
	}

	await env.db.prepare('DELETE FROM push_subscription WHERE user_id = ? AND endpoint = ?')
		.bind(normalizedUserId, endpoint)
		.run();
	return { subscribed: false };
}

export async function deletePushSubscriptionsForSession(env, userId, sessionToken) {
	if (!sessionToken) return;
	try {
		const sessionIdentifier = await createSessionTokenIdentifier(sessionToken);
		await env.db.prepare('DELETE FROM push_subscription WHERE user_id = ? AND session_token = ?')
			.bind(Number(userId), sessionIdentifier)
			.run();
	} catch (error) {
		console.warn(JSON.stringify({
			event: 'push.subscription.session-cleanup.failed',
			userId: Number(userId) || 0,
			error: errorMessage(error),
		}));
	}
}

function truncate(value, length = PUSH_PAYLOAD_MAX_LENGTH) {
	const text = String(value || '').trim();
	return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function buildMessagePreview(emailRow) {
	return truncate(
		String(emailRow?.text || '').replace(/[\u0000-\u001f\u007f\s]+/g, ' '),
		PUSH_PREVIEW_MAX_LENGTH,
	);
}

export function buildPushPayload(emailRow) {
	const emailId = Number(emailRow?.emailId);
	const sender = truncate(emailRow?.name || emailRow?.sendEmail || '新发件人', 80);
	const subject = truncate(emailRow?.subject || '无主题');
	const preview = buildMessagePreview(emailRow);
	return {
		type: 'mail.received',
		title: sender,
		body: preview ? `${subject}\n${preview}` : subject,
		icon: '/mail-pwa.png',
		badge: '/mail-pwa.png',
		tag: Number.isSafeInteger(emailId) && emailId > 0 ? `cloud-mail-${emailId}` : 'cloud-mail-new',
		url: '/inbox',
		emailId: Number.isSafeInteger(emailId) && emailId > 0 ? emailId : 0,
		sentAt: Date.now(),
	};
}

async function mapLimit(items, limit, handler) {
	let index = 0;
	const results = new Array(items.length);
	async function worker() {
		while (index < items.length) {
			const current = index++;
			results[current] = await handler(items[current]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

async function removeExpiredEndpoint(env, endpoint) {
	await env.db.prepare('DELETE FROM push_subscription WHERE endpoint = ?').bind(endpoint).run();
}

export async function sendPushToUser(env, userId, emailRow, send = null) {
	const normalizedUserId = Number(userId);
	if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) return { delivered: 0, failed: 0 };
	const startedAt = Date.now();

	const authInfoPromise = env.kv.get(KvConst.AUTH_INFO + normalizedUserId, { type: 'json' });
	const subscriptionsPromise = env.db.prepare(`
		SELECT endpoint, p256dh, auth, session_token
		FROM push_subscription
		WHERE user_id = ?
		ORDER BY update_time DESC, push_subscription_id DESC
		LIMIT ?
	`).bind(normalizedUserId, MAX_PUSH_SUBSCRIPTIONS_PER_USER).all();
	const [authInfo, queryResult] = await Promise.all([authInfoPromise, subscriptionsPromise]);
	const activeSessions = new Set(await Promise.all(
		(Array.isArray(authInfo?.tokens) ? authInfo.tokens : []).map(createSessionTokenIdentifier),
	));
	if (!activeSessions.size) return { delivered: 0, failed: 0 };

	const results = (queryResult.results || []).filter(row => activeSessions.has(row.session_token));
	if (!results.length) return { delivered: 0, failed: 0 };

	const pushPayload = buildPushPayload(emailRow);
	const payload = JSON.stringify(pushPayload);
	const { applicationServer } = await createApplicationServer(env);

	const outcomes = await mapLimit(results, PUSH_CONCURRENCY, async row => {
		try {
			if (send) {
				await send(row, payload);
			} else {
				await applicationServer.subscribe({
					endpoint: row.endpoint,
					keys: { p256dh: row.p256dh, auth: row.auth },
				}).pushTextMessage(payload, {
					ttl: PUSH_TTL_SECONDS,
					urgency: Urgency.High,
					topic: pushPayload.tag,
				});
			}
			return true;
		} catch (error) {
			const status = error instanceof PushMessageError ? error.response?.status : Number(error?.status || 0);
			if (status === 404 || status === 410) {
				try {
					await removeExpiredEndpoint(env, row.endpoint);
				} catch (cleanupError) {
					console.error(JSON.stringify({
						event: 'push.subscription.cleanup.failed',
						userId: normalizedUserId,
						error: errorMessage(cleanupError),
					}));
				}
			}
			console.error(JSON.stringify({
				event: 'push.mail.delivery.failed',
				userId: normalizedUserId,
				emailId: Number(emailRow?.emailId) || 0,
				status,
				error: errorMessage(error),
			}));
			return false;
		}
	});

	const delivered = outcomes.filter(Boolean).length;
	const failed = outcomes.length - delivered;
	console.info(JSON.stringify({
		event: 'push.mail.accepted',
		userId: normalizedUserId,
		emailId: Number(emailRow?.emailId) || 0,
		delivered,
		failed,
		durationMs: Date.now() - startedAt,
	}));
	return { delivered, failed };
}

export async function sendPushToUserSafely(env, userId, emailRow) {
	try {
		return await sendPushToUser(env, userId, emailRow);
	} catch (error) {
		console.error(JSON.stringify({
			event: 'push.mail.notify.failed',
			userId: Number(userId) || 0,
			emailId: Number(emailRow?.emailId) || 0,
			error: errorMessage(error),
		}));
		return { delivered: 0, failed: 1 };
	}
}
