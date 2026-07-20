import test from 'node:test'
import assert from 'node:assert/strict'
import {
    base64UrlToUint8Array,
    subscriptionUsesKey,
    uint8ArrayToBase64Url,
} from '../src/services/push-state.js'

test('round trips a VAPID application server key', () => {
    const key = Uint8Array.from({length: 65}, (_, index) => index)
    const encoded = uint8ArrayToBase64Url(key)
    assert.deepEqual(base64UrlToUint8Array(encoded), key)
})

test('detects whether an existing subscription uses the current VAPID key', () => {
    const key = Uint8Array.from([4, 1, 2, 3])
    const subscription = {options: {applicationServerKey: key.buffer}}
    assert.equal(subscriptionUsesKey(subscription, uint8ArrayToBase64Url(key)), true)
    assert.equal(subscriptionUsesKey(subscription, 'different'), false)
    assert.equal(subscriptionUsesKey({}, uint8ArrayToBase64Url(key)), false)
})
