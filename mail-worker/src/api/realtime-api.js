import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import {
	authenticateRealtimeRequest,
	issueRealtimeTicket,
} from '../service/realtime-service';

app.post('/realtime/ticket', async (c) => {
	const userId = userContext.getUserId(c);
	const sessionToken = await userContext.getToken(c);
	const ticket = await issueRealtimeTicket(c, userId, sessionToken);
	return c.json(result.ok(ticket));
});

app.get('/realtime', async (c) => {
	const auth = await authenticateRealtimeRequest(c);
	if (auth.error) {
		return new Response(auth.error, { status: auth.status });
	}

	const stub = c.env.USER_MAIL_HUB.getByName(`user:${auth.userId}`);
	return stub.fetch(c.req.raw);
});
