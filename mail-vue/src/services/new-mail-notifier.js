import {ElNotification} from 'element-plus'
import {accountList} from '@/request/account.js'
import {emailLatest, emailList} from '@/request/email.js'
import {useAccountStore} from '@/store/account.js'
import {useEmailStore} from '@/store/email.js'
import {useSettingStore} from '@/store/setting.js'
import {useUserStore} from '@/store/user.js'
import {hasPerm} from '@/perm/perm.js'
import router from '@/router/index.js'

const DEFAULT_INTERVAL_MS = 30_000
const MAX_BACKOFF_MS = 5 * 60_000
const ACCOUNT_REFRESH_MS = 5 * 60_000
const CONCURRENCY = 4
const MAX_KNOWN_IDS = 2_000
const LATEST_API_LIMIT = 20
const CATCH_UP_PAGE_SIZE = 50
const MAX_CATCH_UP_PAGES = 20

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
    return account.allReceive ? 'all' : String(account.accountId)
}

function notificationTargets(accounts) {
    const allReceiveAccount = accounts.find(account => Number(account.allReceive) === 1)
    return allReceiveAccount ? [allReceiveAccount] : accounts
}

function senderLabel(email) {
    return email.name || email.sendEmail || ''
}

export function createNewMailNotifier(t) {
    const accountStore = useAccountStore()
    const emailStore = useEmailStore()
    const settingStore = useSettingStore()
    const userStore = useUserStore()
    const baselines = new Map()
    const knownIds = new Set()

    let active = false
    let timer = null
    let generation = 0
    let failureCount = 0
    let lastAccountRefresh = 0

    function shouldRun() {
        return settingStore.mailNotificationsEnabled || Number(settingStore.settings.autoRefresh) > 1
    }

    function currentTargets(accounts) {
        if (settingStore.mailNotificationsEnabled) {
            return notificationTargets(accounts)
        }

        const account = accountStore.currentAccount
        return emailStore.emailScroll?.addItem && account?.accountId ? [account] : []
    }

    function configuredInterval() {
        const seconds = Number(settingStore.settings.autoRefresh)
        return seconds > 1 ? seconds * 1000 : DEFAULT_INTERVAL_MS
    }

    function backoffInterval() {
        if (!failureCount) return configuredInterval()
        return Math.min(DEFAULT_INTERVAL_MS * (2 ** (failureCount - 1)), MAX_BACKOFF_MS)
    }

    function schedule(currentGeneration) {
        if (!active || currentGeneration !== generation) return
        clearTimeout(timer)
        timer = setTimeout(() => poll(currentGeneration), backoffInterval())
    }

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

    function showNotifications(emails) {
        if (!emails.length || !settingStore.mailNotificationsEnabled) return

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
                    tag: single ? `cloud-mail-${emails[0].emailId}` : `cloud-mail-${Date.now()}`,
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

    async function poll(currentGeneration) {
        if (!active || currentGeneration !== generation) return

        try {
            const accounts = await loadAllAccounts()
            const targets = currentTargets(accounts)
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
            showNotifications(emails)

            const failures = results.filter(result => result.status === 'rejected')
            if (failures.length) {
                if (failures.some(result => result.reason?.code === 401 || result.reason?.code === 403)) {
                    stop()
                    return
                }
                failureCount++
                console.error('New mail polling failed', failures.map(result => result.reason))
            } else {
                failureCount = 0
            }
        } catch (error) {
            failureCount++
            console.error('New mail polling failed', error)
            if (error?.code === 401 || error?.code === 403) {
                stop()
                return
            }
        }

        schedule(currentGeneration)
    }

    async function start() {
        if (active || !shouldRun()) return

        active = true
        const currentGeneration = ++generation
        failureCount = 0
        baselines.clear()
        knownIds.clear()

        try {
            const accounts = await loadAllAccounts(true)
            const targets = currentTargets(accounts)
            const results = await mapLimit(targets, CONCURRENCY, establishBaseline)
            if (results.some(result => result.status === 'rejected')) {
                failureCount = 1
            }
        } catch (error) {
            failureCount = 1
            console.error('New mail baseline failed', error)
        }

        schedule(currentGeneration)
    }

    function stop() {
        active = false
        generation++
        clearTimeout(timer)
        timer = null
        baselines.clear()
        knownIds.clear()
    }

    return {start, stop}
}
