export function base64UrlToUint8Array(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4)
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
    const raw = atob(base64)
    return Uint8Array.from(raw, character => character.charCodeAt(0))
}

export function uint8ArrayToBase64Url(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function subscriptionUsesKey(subscription, publicKey) {
    const currentKey = subscription?.options?.applicationServerKey
    if (!currentKey) return false
    return uint8ArrayToBase64Url(currentKey) === publicKey
}
