export const DEFAULT_FALLBACK_INTERVAL_MS = 30_000
export const MAX_FALLBACK_BACKOFF_MS = 5 * 60_000

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000]

export function configuredFallbackIntervalMs(autoRefresh) {
    const seconds = Number(autoRefresh)
    return seconds > 1 ? seconds * 1000 : DEFAULT_FALLBACK_INTERVAL_MS
}

export function fallbackDelayMs(autoRefresh, failureCount = 0) {
    if (failureCount <= 0) return configuredFallbackIntervalMs(autoRefresh)
    return Math.min(DEFAULT_FALLBACK_INTERVAL_MS * (2 ** (failureCount - 1)), MAX_FALLBACK_BACKOFF_MS)
}

export function reconnectDelayMs(attempt) {
    const index = Math.min(Math.max(Number(attempt) || 0, 0), RECONNECT_DELAYS_MS.length - 1)
    return RECONNECT_DELAYS_MS[index]
}

export function parseRealtimeMessage(raw) {
    try {
        const event = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (event?.type === 'realtime.ready') return {type: 'realtime.ready'}

        const latestEmailId = Number(event?.latestEmailId)
        if (event?.type === 'mail.changed' && Number.isSafeInteger(latestEmailId) && latestEmailId > 0) {
            return {type: 'mail.changed', latestEmailId}
        }
    } catch {
        // Ignore malformed or unrelated WebSocket messages.
    }
    return null
}

export function selectNotificationTargets(accounts) {
    const allReceiveAccount = accounts.find(account => Number(account.allReceive) === 1)
    return allReceiveAccount ? [allReceiveAccount] : accounts
}

export function createSyncCoordinator(sync) {
    let inFlight = null
    let queued = false
    let queuedNotify = false

    async function drain(notify) {
        let currentNotify = notify
        do {
            queued = false
            queuedNotify = false
            await sync({notify: currentNotify})
            currentNotify = queuedNotify
        } while (queued)
    }

    return function requestSync({notify = false} = {}) {
        if (inFlight) {
            queued = true
            queuedNotify ||= notify
            return inFlight
        }

        inFlight = drain(notify).finally(() => {
            inFlight = null
        })
        return inFlight
    }
}

export function claimNotification(storage, key, emailIds) {
    const latestEmailId = Math.max(0, ...emailIds.map(Number).filter(Number.isSafeInteger))
    if (!latestEmailId) return false

    const previous = Number(storage.getItem(key)) || 0
    if (latestEmailId <= previous) return false
    storage.setItem(key, String(latestEmailId))
    return true
}
