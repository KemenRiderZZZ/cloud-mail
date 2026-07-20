import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../public/push-sw.js', import.meta.url), 'utf8')

async function dispatchPush(windowClients, payload = {}) {
    const handlers = new Map()
    const notifications = []
    const messages = []
    const clientsApi = {
        matchAll: async () => windowClients.map(client => ({
            ...client,
            postMessage(message) {
                messages.push(message)
            },
        })),
    }
    const selfApi = {
        location: {origin: 'https://mail.kamenr.com'},
        registration: {
            async showNotification(title, options) {
                notifications.push({title, options})
            },
        },
        addEventListener(type, handler) {
            handlers.set(type, handler)
        },
    }

    vm.runInNewContext(source, {
        self: selfApi,
        clients: clientsApi,
        URL,
        Promise,
        Number,
    })

    let work
    handlers.get('push')({
        data: {json: () => payload},
        waitUntil(promise) { work = promise },
    })
    await work
    return {notifications, messages}
}

test('shows a system notification when Cloud Mail is visible but not focused', async () => {
    const sentAt = Date.now() - 100
    const result = await dispatchPush([
        {visibilityState: 'visible', focused: false},
    ], {
        title: 'Sender',
        body: 'Subject\nPreview',
        tag: 'cloud-mail-42',
        sentAt,
        emailId: 42,
    })

    assert.equal(result.notifications.length, 1)
    assert.equal(result.notifications[0].title, 'Sender')
    assert.equal(result.notifications[0].options.timestamp, sentAt)
    assert.equal(result.notifications[0].options.renotify, true)
    assert.equal(result.messages.length, 1)
    assert.equal(result.messages[0].type, 'mail.push.received')
    assert.equal(result.messages[0].emailId, 42)
})

test('uses the in-app notification only while Cloud Mail is focused', async () => {
    const result = await dispatchPush([
        {visibilityState: 'visible', focused: true},
    ], {emailId: 43})

    assert.equal(result.notifications.length, 0)
    assert.equal(result.messages.length, 1)
    assert.equal(result.messages[0].type, 'mail.push.received')
    assert.equal(result.messages[0].emailId, 43)
})
