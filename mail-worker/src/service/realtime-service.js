import jwtUtils from '../utils/jwt-utils';
import KvConst from '../const/kv-const';

export const REALTIME_TICKET_TTL_SECONDS = 60;
export const REALTIME_TICKET_PURPOSE = 'mail-realtime';

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

export function isSameOrigin(request) {
	const origin = request.headers.get('Origin');
	if (!origin) return false;

	try {
		return new URL(origin).origin === new URL(request.url).origin;
	} catch {
		return false;
	}
}

export function isRealtimeTicket(payload) {
	return payload?.purpose === REALTIME_TICKET_PURPOSE
		&& Number.isSafeInteger(Number(payload.userId))
		&& Number(payload.userId) > 0
		&& typeof payload.sessionToken === 'string'
		&& payload.sessionToken.length > 0;
}

export async function issueRealtimeTicket(c, userId, sessionToken) {
	const ticket = await jwtUtils.generateToken(c, {
		purpose: REALTIME_TICKET_PURPOSE,
		userId: Number(userId),
		sessionToken,
		jti: crypto.randomUUID(),
	}, REALTIME_TICKET_TTL_SECONDS);

	return {
		ticket,
		expiresAt: Date.now() + REALTIME_TICKET_TTL_SECONDS * 1000,
	};
}

export async function authenticateRealtimeRequest(c) {
	if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
		return { error: 'Expected a WebSocket upgrade', status: 426 };
	}

	if (!isSameOrigin(c.req.raw)) {
		return { error: 'WebSocket origin is not allowed', status: 403 };
	}

	const ticket = c.req.query('ticket');
	if (!ticket) {
		return { error: 'Missing realtime ticket', status: 401 };
	}

	const payload = await jwtUtils.verifyToken(c, ticket);
	if (!isRealtimeTicket(payload)) {
		return { error: 'Invalid or expired realtime ticket', status: 401 };
	}

	const userId = Number(payload.userId);
	const authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userId, { type: 'json' });
	if (Number(authInfo?.user?.userId) !== userId
		|| !Array.isArray(authInfo.tokens)
		|| !authInfo.tokens.includes(payload.sessionToken)) {
		return { error: 'Login session has expired', status: 401 };
	}

	return { userId };
}

export async function notifyUserMailChanged(env, userId, latestEmailId) {
	const normalizedUserId = Number(userId);
	const normalizedEmailId = Number(latestEmailId);
	if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) return { delivered: 0 };
	if (!Number.isSafeInteger(normalizedEmailId) || normalizedEmailId <= 0) return { delivered: 0 };

	const stub = env.USER_MAIL_HUB.getByName(`user:${normalizedUserId}`);
	return stub.notify({ type: 'mail.changed', latestEmailId: normalizedEmailId });
}

export async function notifyUserMailChangedSafely(env, userId, latestEmailId) {
	try {
		return await notifyUserMailChanged(env, userId, latestEmailId);
	} catch (error) {
		console.error(JSON.stringify({
			event: 'realtime.mail.notify.failed',
			userId: Number(userId) || 0,
			latestEmailId: Number(latestEmailId) || 0,
			error: errorMessage(error),
		}));
		return { delivered: 0, failed: true };
	}
}
