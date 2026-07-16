import { DurableObject } from 'cloudflare:workers';

const CLIENT_TAG = 'mail-client';

export class UserMailHub extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	async fetch(request) {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('Expected a WebSocket upgrade', { status: 426 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server, [CLIENT_TAG]);
		server.serializeAttachment({ connectedAt: Date.now() });
		server.send(JSON.stringify({ type: 'realtime.ready' }));

		return new Response(null, { status: 101, webSocket: client });
	}

	async notify(event) {
		const latestEmailId = Number(event?.latestEmailId);
		if (event?.type !== 'mail.changed' || !Number.isSafeInteger(latestEmailId) || latestEmailId <= 0) {
			throw new TypeError('Invalid realtime mail event');
		}

		const message = JSON.stringify({ type: 'mail.changed', latestEmailId });
		let delivered = 0;

		for (const socket of this.ctx.getWebSockets(CLIENT_TAG)) {
			try {
				socket.send(message);
				delivered++;
			} catch {
				socket.close(1011, 'Broadcast failed');
			}
		}

		return { delivered };
	}

	async webSocketMessage(socket, message) {
		if (typeof message !== 'string') {
			socket.close(1003, 'Binary messages are not supported');
		}
	}

	async webSocketClose(socket, code, reason) {
		socket.close(code, reason);
	}

	async webSocketError(socket) {
		socket.close(1011, 'WebSocket error');
	}
}
