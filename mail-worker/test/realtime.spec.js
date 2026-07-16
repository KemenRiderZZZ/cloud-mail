import { describe, it, expect, vi } from 'vitest';
import jwtUtils from '../src/utils/jwt-utils';
import { UserMailHub } from '../src/realtime/user-mail-hub';
import {
	REALTIME_TICKET_PURPOSE,
	authenticateRealtimeRequest,
	isRealtimeTicket,
	isSameOrigin,
	notifyUserMailChangedSafely,
} from '../src/service/realtime-service';

function fakeContext(request, {authInfo = null, jwtSecret = 'test-secret'} = {}) {
	const url = new URL(request.url);
	return {
		req: {
			raw: request,
			header: name => request.headers.get(name),
			query: name => url.searchParams.get(name),
		},
		env: {
			jwt_secret: jwtSecret,
			kv: {get: vi.fn(async () => authInfo)},
		},
	};
}

function upgradeRequest(ticket = '', origin = 'https://mail.example') {
	const url = new URL('/realtime', 'https://mail.example');
	if (ticket) url.searchParams.set('ticket', ticket);
	return new Request(url, {headers: {Upgrade: 'websocket', Origin: origin}});
}

describe('realtime request validation', () => {
	it('rejects missing tickets, non-WebSocket requests, and cross-origin upgrades', async () => {
		expect(await authenticateRealtimeRequest(fakeContext(upgradeRequest()))).toEqual({
			error: 'Missing realtime ticket', status: 401,
		});
		expect(await authenticateRealtimeRequest(fakeContext(new Request('https://mail.example/realtime')))).toEqual({
			error: 'Expected a WebSocket upgrade', status: 426,
		});
		expect(isSameOrigin(upgradeRequest('x', 'https://attacker.example'))).toBe(false);
	});

	it('distinguishes realtime tickets from login and wrong-purpose tokens', () => {
		expect(isRealtimeTicket({
			purpose: REALTIME_TICKET_PURPOSE,
			userId: 7,
			sessionToken: 'session-token',
		})).toBe(true);
		expect(isRealtimeTicket({purpose: 'login', userId: 7, sessionToken: 'session-token'})).toBe(false);
		expect(isRealtimeTicket({purpose: REALTIME_TICKET_PURPOSE, userId: 0, sessionToken: 'x'})).toBe(false);
	});

	it('rejects expired, wrong-purpose, and logged-out tickets', async () => {
		const signer = fakeContext(upgradeRequest());
		const base = {userId: 7, sessionToken: 'session-token'};
		const expired = await jwtUtils.generateToken(signer, {
			...base, purpose: REALTIME_TICKET_PURPOSE,
		}, -1);
		const wrongPurpose = await jwtUtils.generateToken(signer, {...base, purpose: 'login'}, 60);
		const loggedOut = await jwtUtils.generateToken(signer, {
			...base, purpose: REALTIME_TICKET_PURPOSE,
		}, 60);

		for (const ticket of [expired, wrongPurpose]) {
			expect(await authenticateRealtimeRequest(fakeContext(upgradeRequest(ticket)))).toEqual({
				error: 'Invalid or expired realtime ticket', status: 401,
			});
		}
		expect(await authenticateRealtimeRequest(fakeContext(upgradeRequest(loggedOut)))).toEqual({
			error: 'Login session has expired', status: 401,
		});
	});

	it('accepts a same-origin ticket backed by an active login session', async () => {
		const userId = 7;
		const sessionToken = 'session-token';
		const signer = fakeContext(upgradeRequest());
		const ticket = await jwtUtils.generateToken(signer, {
			purpose: REALTIME_TICKET_PURPOSE, userId, sessionToken,
		}, 60);
		const authInfo = {user: {userId}, tokens: [sessionToken]};

		expect(await authenticateRealtimeRequest(fakeContext(upgradeRequest(ticket), {authInfo}))).toEqual({userId});
	});
});

describe('UserMailHub broadcasts', () => {
	it('sends one change signal to every active connection', async () => {
		const sockets = [
			{send: vi.fn(), close: vi.fn()},
			{send: vi.fn(), close: vi.fn()},
		];
		const ctx = {
			setWebSocketAutoResponse: vi.fn(),
			getWebSockets: vi.fn(() => sockets),
		};
		globalThis.WebSocketRequestResponsePair = class {
			constructor(request, response) {
				this.request = request;
				this.response = response;
			}
		};
		const hub = new UserMailHub(ctx, {});

		expect(await hub.notify({type: 'mail.changed', latestEmailId: 12345})).toEqual({delivered: 2});
		for (const socket of sockets) {
			expect(socket.send).toHaveBeenCalledWith('{"type":"mail.changed","latestEmailId":12345}');
		}
	});

	it('does not propagate broadcast failures into mail persistence callers', async () => {
		const failingEnv = {
			USER_MAIL_HUB: {
				getByName: () => ({notify: async () => { throw new Error('temporary DO failure'); }}),
			},
		};
		await expect(notifyUserMailChangedSafely(failingEnv, 1, 2)).resolves.toEqual({
			delivered: 0,
			failed: true,
		});
	});
});
