/* global self, clients */

function safePayload(event) {
  if (!event.data) return {}
  try {
    return event.data.json()
  } catch {
    return {body: event.data.text()}
  }
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    const payload = safePayload(event)
    const windowClients = await clients.matchAll({type: 'window', includeUncontrolled: true})
    await Promise.all(windowClients.map(client => client.postMessage({
      type: 'mail.push.received',
      emailId: Number(payload.emailId) || 0,
    })))

    const hasVisibleClient = windowClients.some(client => client.visibilityState === 'visible')
    if (hasVisibleClient) return

    await self.registration.showNotification(payload.title || 'Cloud Mail', {
      body: payload.body || '收到新邮件',
      icon: payload.icon || '/mail-pwa.png',
      badge: payload.badge || '/mail-pwa.png',
      tag: payload.tag || 'cloud-mail-new',
      data: {url: payload.url || '/inbox'},
    })
  })())
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil((async () => {
    const targetUrl = new URL(event.notification.data?.url || '/inbox', self.location.origin).href
    const windowClients = await clients.matchAll({type: 'window', includeUncontrolled: true})

    for (const client of windowClients) {
      if (typeof client.navigate === 'function') await client.navigate(targetUrl)
      if (typeof client.focus === 'function') return client.focus()
    }
    return clients.openWindow(targetUrl)
  })())
})
