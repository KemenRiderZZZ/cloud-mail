import http from '@/axios/index.js'

export function pushConfig() {
    return http.get('/push/config', {noMsg: true})
}

export function savePushSubscription(subscription) {
    return http.post('/push/subscription', subscription)
}

export function removePushSubscription(endpoint) {
    return http.delete('/push/subscription', {data: {endpoint}})
}
