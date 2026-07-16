import http from '@/axios/index.js'

export function realtimeTicket() {
    return http.post('/realtime/ticket', null, {noMsg: true})
}
