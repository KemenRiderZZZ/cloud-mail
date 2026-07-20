import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import {
	deletePushSubscription,
	getPushConfig,
	savePushSubscription,
} from '../service/push-service';

app.get('/push/config', async (c) => {
	return c.json(result.ok(await getPushConfig(c.env)));
});

app.post('/push/subscription', async (c) => {
	const data = await savePushSubscription(
		c.env,
		userContext.getUserId(c),
		await userContext.getToken(c),
		await c.req.json(),
		c.req.header('User-Agent'),
	);
	return c.json(result.ok(data));
});

app.delete('/push/subscription', async (c) => {
	const { endpoint } = await c.req.json();
	const data = await deletePushSubscription(c.env, userContext.getUserId(c), endpoint);
	return c.json(result.ok(data));
});
