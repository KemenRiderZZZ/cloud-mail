import {ElNotification} from 'element-plus'
import {accountList} from '@/request/account.js'
import {emailLatest, emailList} from '@/request/email.js'
import {realtimeTicket} from '@/request/realtime.js'
import {useAccountStore} from '@/store/account.js'
import {useEmailStore} from '@/store/email.js'
import {useSettingStore} from '@/store/setting.js'
import {useUserStore} from '@/store/user.js'
import {hasPerm} from '@/perm/perm.js'
import router from '@/router/index.js'
import {
    claimNotification,
    createSyncCoordinator,
    fallbackDelayMs,
    parseRealtimeMessage,
    reconnectDelayMs,
    selectNotificationTargets,
} from '@/services/realtime-state.js'

const ACCOUNT_REFRESH_MS = 5 * 60_000
const CONNECTED_SAFETY_SYNC_MS = 5 * 60_000
const DISCONNECTED_FALLBACK_DELAY_MS = 10_000
const LEADER_RETRY_MS = 5_000
const HEARTBEAT_MS = 30_000
const CONCURRENCY = 4
const MAX_KNOWN_IDS = 2_000
const LATEST_API_LIMIT = 20
const CATCH_UP_PAGE_SIZE = 50
const MAX_CATCH_UP_PAGES = 20
const LOCK_NAME = 'cloud-mail-realtime-leader'
const CHANNEL_NAME = 'cloud-mail-realtime'

async function mapLimit(items, limit, handler) {
    const results = new Array(items.length)
    let index = 0

    async function worker() {
        while (index < items.length) {
            const current = index++
            try {
                results[current] = {status: 'fulfilled', value: await handler(items[current])}
            } catch (reason) {
                results[current] = {status: 'rejected', reason}
            }
        }
    }

    await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker))
    return results
}

function targetKey(account) {
    return Number(account.allReceive) === 1 ? 'all' : String(account.accountId)
}

function senderLabel(email) {
    return email.name || email.sendEmail || ''
}

function isAuthError(error) {
    const code = Number(error?.code || error?.response?.status)
    return code === 401 || code === 403
}

function websocketUrl(ticket) {
    const url = new URL(import.meta.env.VITE_BASE_URL || '/api', window.location.origin)
    url.pathname = `${url.pathname.replace(/\/$/, '')}/realtime`
    url.search = ''
    url.searchParams.set('ticket', ticket)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.toString()
}

export function createNewMailNotifier(t) {
    const accountStore = useAccountStore()
    const emailStore = useEmailStore()
    const settingStore = useSettingStore()
    const userStore = useUserStore()
    const baselines = new Map()
    const knownIds = new Set()

    let active = false
    let generation = 0
    let lastAccountRefresh = 0
    let socket = null
    let connected = false
    let leader = false
    let reconnectAttempt = 0
    let fallbackFailures = 0
    let fallbackStartTimer = null
    let fallbackTimer = null
    let reconnectTimer = null
    let safetyTimer = null
    let heartbeatTimer = null
    let leaderRetryTimer = null
    let broadcastChannel = null
    let lockRelease = null
    let lockAttemptInFlight = false

    const supportsCoordinatedLeadership = Boolean(navigator.locks?.request && window.BroadcastChannel)

    async function loadAllAccounts(force = false) {
        if (!hasPerm('account:query')) {
            const visible = [userStore.user.account, ...accountStore.accounts].filter(Boolean)
            return [...new Map(visible.map(account => [account.accountId, account])).values()]
        }

        if (!force && Date.now() - lastAccountRefresh < ACCOUNT_REFRESH_MS && accountStore.accounts.length) {
            return accountStore.accounts
        }

        const accounts = []
        let accountId = 0
        let lastSort

        for (let page = 0; page < 200; page++) {
            const list = await accountList(accountId, 30, lastSort)
            accounts.push(...list)
            if (list.length < 30) break
            accountId = list.at(-1).accountId
            lastSort = list.at(-1).sort
        }

        accountStore.replaceAccounts(accounts)
        lastAccountRefresh = Date.now()
        return accounts
    }

    async function establishBaseline(account) {
        const key = targetKey(account)
        if (baselines.has(key)) return

        const data = await emailList(account.accountId, account.allReceive, 0, 0, 1, 0, '')
        baselines.set(key, Number(data.latestEmail?.emailId) || 0)
    }

    function trimKnownIds() {
        while (knownIds.size > MAX_KNOWN_IDS) {
            knownIds.delete(knownIds.values().next().value)
        }
    }

    function addToVisibleInbox(emails) {
        const scroll = emailStore.emailScroll
        if (!scroll?.addItem || emailStore.inboxSearchActive) return

        const currentAccount = accountStore.currentAccount
        for (const email of emails) {
            const visible = Number(currentAccount.allReceive) === 1
                || Number(currentAccount.accountId) === Number(email.accountId)
            if (visible) {
                email.reqAccountId = currentAccount.accountId
                email.allReceive = currentAccount.allReceive
                scroll.addItem(email)
            }
        }
    }

    function openInbox() {
        window.focus()
        router.push('/inbox')
    }

    function notificationClaimKey() {
        return `cloud-mail-realtime-notified:${Number(userStore.user.userId) || 'unknown'}`
    }

    function showNotifications(emails) {
        if (!emails.length || !settingStore.mailNotificationsEnabled || !leader) return
        try {
            if (!claimNotification(localStorage, notificationClaimKey(), emails.map(email => email.emailId))) return
        } catch (error) {
            console.error('Shared notification deduplication failed', error)
        }

        const single = emails.length === 1
        const title = single ? t('newMailNotificationTitle') : t('newMailNotificationCount', {count: emails.length})
        const message = single
            ? `${senderLabel(emails[0])} · ${emails[0].subject || t('noSubject')}`
            : t('newMailNotificationSummary', {count: emails.length})

        ElNotification({
            title,
            message,
            type: 'info',
            position: 'bottom-right',
            onClick: openInbox,
        })

        if ('Notification' in window && Notification.permission === 'granted') {
            try {
                const notification = new Notification(title, {
                    body: message,
                    icon: '/mail-pwa.png',
                    tag: single ? `cloud-mail-${emails[0].emailId}` : `cloud-mail-${Math.max(...emails.map(item => item.emailId))}`,
                })
                notification.onclick = () => {
                    notification.close()
                    openInbox()
                }
            } catch (error) {
                console.error('Desktop notification failed', error)
            }
        }
    }

    async function pollTarget(account) {
        const key = targetKey(account)
        if (!baselines.has(key)) {
            await establishBaseline(account)
            return []
        }

        const baseline = baselines.get(key)
        let list = await emailLatest(baseline, account.accountId, account.allReceive)
        if (!list.length) return []

        if (list.length === LATEST_API_LIMIT) {
            list = []
            let cursor = baseline

            for (let page = 0; page < MAX_CATCH_UP_PAGES; page++) {
                const data = await emailList(
                    account.accountId,
                    account.allReceive,
                    cursor,
                    1,
                    CATCH_UP_PAGE_SIZE,
                    0,
                    '',
                )
                const batch = data.list || []
                if (!batch.length) break

                list.push(...batch)
                cursor = Math.max(cursor, ...batch.map(email => Number(email.emailId) || 0))
                if (batch.length < CATCH_UP_PAGE_SIZE) break
            }
        }

        baselines.set(key, Math.max(baseline, ...list.map(email => Number(email.emailId) || 0)))
        return list.filter(email => {
            const id = Number(email.emailId)
            if (!id || knownIds.has(id)) return false
            knownIds.add(id)
            return true
        })
    }

    async function syncNow({notify}) {
        const accounts = await loadAllAccounts()
        const targets = selectNotificationTargets(accounts)
        const activeKeys = new Set(targets.map(targetKey))
        for (const key of baselines.keys()) {
            if (!activeKeys.has(key)) baselines.delete(key)
        }

        const results = await mapLimit(targets, CONCURRENCY, pollTarget)
        const emails = results
            .filter(result => result.status === 'fulfilled')
            .flatMap(result => result.value)
            .sort((a, b) => Number(a.emailId) - Number(b.emailId))

        trimKnownIds()
        addToVisibleInbox(emails)
        if (notify) showNotifications(emails)

        const failures = results.filter(result => result.status === 'rejected')
        if (failures.length) throw failures[0].reason
        return emails
    }

    const requestSync = createSyncCoordinator(syncNow)

    function clearTimer(name) {
        if (name === 'fallbackStart') {
            clearTimeout(fallbackStartTimer)
            fallbackStartTimer = null
        } else if (name === 'fallback') {
            clearTimeout(fallbackTimer)
            fallbackTimer = null
        } else if (name === 'reconnect') {
            clearTimeout(reconnectTimer)
            reconnectTimer = null
        } else if (name === 'safety') {
            clearInterval(safetyTimer)
            safetyTimer = null
        } else if (name === 'heartbeat') {
            clearInterval(heartbeatTimer)
            heartbeatTimer = null
        } else if (name === 'leaderRetry') {
            clearTimeout(leaderRetryTimer)
            leaderRetryTimer = null
        }
    }

    function handleSyncError(label, error) {
        console.error(label, error)
        if (isAuthError(error)) stop()
    }

    function scheduleFallback(currentGeneration, immediate = false) {
        if (!active || connected || currentGeneration !== generation) return
        clearTimer('fallback')
        const delay = immediate ? 0 : fallbackDelayMs(settingStore.settings.autoRefresh, fallbackFailures)
        fallbackTimer = setTimeout(async () => {
            try {
                await requestSync({notify: leader})
                fallbackFailures = 0
            } catch (error) {
                fallbackFailures++
                handleSyncError('Realtime fallback sync failed', error)
            }
            scheduleFallback(currentGeneration)
        }, delay)
    }

    function startDisconnectedFallback(currentGeneration) {
        if (!active || connected || currentGeneration !== generation || fallbackStartTimer || fallbackTimer) return
        if (supportsCoordinatedLeadership && !leader) return
        fallbackStartTimer = setTimeout(() => {
            fallbackStartTimer = null
            scheduleFallback(currentGeneration, true)
        }, DISCONNECTED_FALLBACK_DELAY_MS)
    }

    function startConnectedMaintenance(currentGeneration) {
        clearTimer('safety')
        clearTimer('heartbeat')
        safetyTimer = setInterval(() => {
            requestSync({notify: leader}).catch(error => handleSyncError('Realtime safety sync failed', error))
        }, CONNECTED_SAFETY_SYNC_MS)
        heartbeatTimer = setInterval(() => {
            if (socket?.readyState === WebSocket.OPEN) socket.send('ping')
        }, HEARTBEAT_MS)
    }

    function markDisconnected(currentGeneration) {
        connected = false
        clearTimer('safety')
        clearTimer('heartbeat')
        startDisconnectedFallback(currentGeneration)
    }

    function scheduleReconnect(currentGeneration) {
        if (!active || !leader || currentGeneration !== generation || reconnectTimer) return
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null
            connectSocket(currentGeneration)
        }, reconnectDelayMs(reconnectAttempt++))
    }

    async function connectSocket(currentGeneration) {
        if (!active || !leader || currentGeneration !== generation || !navigator.onLine) return
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return

        try {
            const {ticket} = await realtimeTicket()
            if (!active || !leader || currentGeneration !== generation) return

            const currentSocket = new WebSocket(websocketUrl(ticket))
            socket = currentSocket

            currentSocket.onopen = () => {
                if (socket !== currentSocket || !active) return
                connected = true
                reconnectAttempt = 0
                fallbackFailures = 0
                clearTimer('fallbackStart')
                clearTimer('fallback')
                startConnectedMaintenance(currentGeneration)
                requestSync({notify: true}).catch(error => handleSyncError('Realtime connection catch-up failed', error))
            }

            currentSocket.onmessage = message => {
                const event = parseRealtimeMessage(message.data)
                if (event?.type !== 'mail.changed') return
                requestSync({notify: true}).catch(error => handleSyncError('Realtime event sync failed', error))
                broadcastChannel?.postMessage(event)
            }

            currentSocket.onclose = () => {
                if (socket !== currentSocket) return
                socket = null
                markDisconnected(currentGeneration)
                scheduleReconnect(currentGeneration)
            }

            currentSocket.onerror = () => currentSocket.close()
        } catch (error) {
            markDisconnected(currentGeneration)
            handleSyncError('Realtime connection failed', error)
            if (!isAuthError(error)) scheduleReconnect(currentGeneration)
        }
    }

    function releaseSocket() {
        const currentSocket = socket
        socket = null
        connected = false
        if (currentSocket && currentSocket.readyState < WebSocket.CLOSING) {
            currentSocket.close(1000, 'Leadership released')
        }
        clearTimer('reconnect')
        clearTimer('safety')
        clearTimer('heartbeat')
    }

    function scheduleLeaderRetry(currentGeneration) {
        if (!active || currentGeneration !== generation || leaderRetryTimer) return
        leaderRetryTimer = setTimeout(() => {
            leaderRetryTimer = null
            tryAcquireLeadership(currentGeneration)
        }, LEADER_RETRY_MS)
    }

    function tryAcquireLeadership(currentGeneration) {
        if (!active || currentGeneration !== generation || lockAttemptInFlight) return

        if (!supportsCoordinatedLeadership) {
            leader = true
            connectSocket(currentGeneration)
            return
        }

        lockAttemptInFlight = true
        navigator.locks.request(LOCK_NAME, {ifAvailable: true}, async lock => {
            if (!active || currentGeneration !== generation) return
            if (!lock) {
                leader = false
                scheduleLeaderRetry(currentGeneration)
                return
            }

            leader = true
            connectSocket(currentGeneration)
            await new Promise(resolve => { lockRelease = resolve })
            lockRelease = null
            leader = false
            releaseSocket()
        }).catch(error => {
            console.error('Realtime leader election failed', error)
            leader = true
            connectSocket(currentGeneration)
        }).finally(() => {
            lockAttemptInFlight = false
        })
    }

    function handleBroadcast(message) {
        const event = parseRealtimeMessage(message.data)
        if (event?.type === 'mail.changed') {
            requestSync({notify: false}).catch(error => handleSyncError('Realtime tab sync failed', error))
        }
    }

    function handleOnline() {
        if (!active) return
        requestSync({notify: leader}).catch(error => handleSyncError('Realtime online sync failed', error))
        if (leader) connectSocket(generation)
    }

    function handleOffline() {
        if (!active) return
        releaseSocket()
        startDisconnectedFallback(generation)
        if (leader) scheduleReconnect(generation)
    }

    function handleVisibilityChange() {
        if (!active || document.visibilityState !== 'visible') return
        requestSync({notify: leader}).catch(error => handleSyncError('Realtime visibility sync failed', error))
        if (leader && !connected) connectSocket(generation)
    }

    async function start() {
        if (active) return

        active = true
        const currentGeneration = ++generation
        reconnectAttempt = 0
        fallbackFailures = 0
        baselines.clear()
        knownIds.clear()

        if (window.BroadcastChannel) {
            broadcastChannel = new BroadcastChannel(CHANNEL_NAME)
            broadcastChannel.onmessage = handleBroadcast
        }
        window.addEventListener('online', handleOnline)
        window.addEventListener('offline', handleOffline)
        document.addEventListener('visibilitychange', handleVisibilityChange)

        try {
            const accounts = await loadAllAccounts(true)
            const targets = selectNotificationTargets(accounts)
            const results = await mapLimit(targets, CONCURRENCY, establishBaseline)
            const failure = results.find(result => result.status === 'rejected')
            if (failure) throw failure.reason
        } catch (error) {
            handleSyncError('New mail baseline failed', error)
        }

        if (!active || currentGeneration !== generation) return
        tryAcquireLeadership(currentGeneration)
        startDisconnectedFallback(currentGeneration)
    }

    function stop() {
        if (!active) return
        active = false
        generation++
        lockRelease?.()
        lockRelease = null
        leader = false
        releaseSocket()
        clearTimer('fallbackStart')
        clearTimer('fallback')
        clearTimer('leaderRetry')
        broadcastChannel?.close()
        broadcastChannel = null
        window.removeEventListener('online', handleOnline)
        window.removeEventListener('offline', handleOffline)
        document.removeEventListener('visibilitychange', handleVisibilityChange)
        baselines.clear()
        knownIds.clear()
    }

    return {start, stop}
}
