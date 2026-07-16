import test from 'node:test'
import assert from 'node:assert/strict'
import {
    claimNotification,
    configuredFallbackIntervalMs,
    createSyncCoordinator,
    fallbackDelayMs,
    parseRealtimeMessage,
    reconnectDelayMs,
    selectNotificationTargets,
} from '../src/services/realtime-state.js'

test('uses configured polling interval or a 30 second fallback', () => {
    assert.equal(configuredFallbackIntervalMs(5), 5_000)
    assert.equal(configuredFallbackIntervalMs(0), 30_000)
    assert.equal(fallbackDelayMs(5, 1), 30_000)
    assert.equal(fallbackDelayMs(5, 10), 300_000)
})

test('reconnect delay backs off and caps at 30 seconds', () => {
    assert.equal(reconnectDelayMs(0), 1_000)
    assert.equal(reconnectDelayMs(2), 5_000)
    assert.equal(reconnectDelayMs(99), 30_000)
})

test('accepts only supported realtime messages', () => {
    assert.deepEqual(parseRealtimeMessage('{"type":"mail.changed","latestEmailId":42}'), {
        type: 'mail.changed', latestEmailId: 42,
    })
    assert.deepEqual(parseRealtimeMessage('{"type":"realtime.ready"}'), {type: 'realtime.ready'})
    assert.equal(parseRealtimeMessage('{"type":"mail.changed","latestEmailId":0}'), null)
    assert.equal(parseRealtimeMessage('not json'), null)
})

test('an all-receive account replaces per-account polling', () => {
    const accounts = [{accountId: 1, allReceive: 0}, {accountId: 2, allReceive: 1}]
    assert.deepEqual(selectNotificationTargets(accounts), [accounts[1]])
})

test('coalesces events arriving during an active sync', async () => {
    const calls = []
    let release
    const first = new Promise(resolve => { release = resolve })
    const sync = createSyncCoordinator(async options => {
        calls.push(options)
        if (calls.length === 1) await first
    })

    const running = sync({notify: false})
    sync({notify: true})
    sync({notify: false})
    release()
    await running

    assert.deepEqual(calls, [{notify: false}, {notify: true}])
})

test('shared high-water mark prevents duplicate notifications', () => {
    const values = new Map()
    const storage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    }
    assert.equal(claimNotification(storage, 'user:1', [10, 11]), true)
    assert.equal(claimNotification(storage, 'user:1', [11]), false)
    assert.equal(claimNotification(storage, 'user:1', [12]), true)
})
