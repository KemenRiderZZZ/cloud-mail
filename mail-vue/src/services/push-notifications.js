import {
    pushConfig,
    removePushSubscription,
    savePushSubscription,
} from '@/request/push.js'
import {
    base64UrlToUint8Array,
    subscriptionUsesKey,
} from '@/services/push-state.js'

const SERVICE_WORKER_READY_TIMEOUT_MS = 15_000

export function supportsWebPush() {
    return 'serviceWorker' in navigator
        && 'PushManager' in window
        && 'Notification' in window
}

async function serviceWorkerRegistration() {
    if (!supportsWebPush()) throw new Error('Web Push is not supported')
    let timeout
    try {
        return await Promise.race([
            navigator.serviceWorker.ready,
            new Promise((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error('Service Worker registration timed out')),
                    SERVICE_WORKER_READY_TIMEOUT_MS,
                )
            }),
        ])
    } finally {
        clearTimeout(timeout)
    }
}

async function getSubscription() {
    if (!supportsWebPush()) return null
    const registration = await serviceWorkerRegistration()
    return registration.pushManager.getSubscription()
}

export async function getPushNotificationState() {
    if (!supportsWebPush()) {
        return {supported: false, permission: 'unsupported', subscribed: false}
    }

    let subscription = null
    try {
        subscription = await getSubscription()
    } catch (error) {
        console.error('Unable to inspect Web Push subscription', error)
    }
    return {
        supported: true,
        permission: Notification.permission,
        subscribed: Boolean(subscription),
    }
}

export async function enablePushNotifications({requestPermission = true} = {}) {
    if (!supportsWebPush()) return getPushNotificationState()

    let permission = Notification.permission
    if (permission === 'default' && requestPermission) {
        permission = await Notification.requestPermission()
    }
    if (permission !== 'granted') return getPushNotificationState()

    const config = await pushConfig()
    if (!config?.enabled || !config.publicKey) {
        throw new Error('Cloud Mail Web Push is not configured')
    }

    const registration = await serviceWorkerRegistration()
    let subscription = await registration.pushManager.getSubscription()
    if (subscription && !subscriptionUsesKey(subscription, config.publicKey)) {
        try {
            await removePushSubscription(subscription.endpoint)
        } catch (error) {
            console.warn('Unable to remove rotated Web Push subscription', error)
        }
        await subscription.unsubscribe()
        subscription = null
    }

    if (!subscription) {
        subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: base64UrlToUint8Array(config.publicKey),
        })
    }

    await savePushSubscription(subscription.toJSON())
    return {supported: true, permission, subscribed: true}
}

export async function disablePushNotifications() {
    if (!supportsWebPush()) return {supported: false, permission: 'unsupported', subscribed: false}

    const subscription = await getSubscription()
    if (!subscription) return getPushNotificationState()

    try {
        await removePushSubscription(subscription.endpoint)
    } catch (error) {
        console.warn('Unable to remove Web Push subscription from Cloud Mail', error)
    }
    await subscription.unsubscribe()
    return {supported: true, permission: Notification.permission, subscribed: false}
}
