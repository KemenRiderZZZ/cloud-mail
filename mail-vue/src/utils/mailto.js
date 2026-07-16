export const PENDING_MAILTO_KEY = 'cloud-mail:pending-mailto'
export const MAX_MAILTO_URI_LENGTH = 200_000
export const MAX_MAILTO_SUBJECT_LENGTH = 998
export const MAX_MAILTO_BODY_LENGTH = 100_000

const EMAIL_PATTERN = /^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[^\s@<>(),;:]+$/u
const UNSUPPORTED_PARAMETERS = new Set([
    'cc',
    'bcc',
    'attach',
    'attachment',
    'attachments',
])

function safeDecode(value) {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

function normalizeMailtoUri(value) {
    let uri = String(value || '').trim()

    if (!uri.toLowerCase().startsWith('mailto:')) {
        const decoded = safeDecode(uri)
        if (decoded.toLowerCase().startsWith('mailto:')) {
            uri = decoded
        }
    }

    return uri
}

function splitRecipients(value) {
    return safeDecode(String(value || ''))
        .split(/[;,，；]/u)
        .map(item => item.trim())
        .filter(Boolean)
}

/**
 * Parse an external mailto URI without trusting any URI-provided HTML.
 * The returned body is plain text; callers must escape it before using it as HTML.
 */
export function parseMailto(value) {
    const warnings = []
    let uri = normalizeMailtoUri(value)

    if (uri.length > MAX_MAILTO_URI_LENGTH) {
        uri = uri.slice(0, MAX_MAILTO_URI_LENGTH)
        warnings.push({code: 'uri-truncated'})
    }

    if (!uri.toLowerCase().startsWith('mailto:')) {
        return {
            to: [],
            subject: '',
            bodyText: '',
            warnings: [...warnings, {code: 'invalid-uri'}],
        }
    }

    const payload = uri.slice('mailto:'.length)
    const queryIndex = payload.indexOf('?')
    const pathPart = queryIndex >= 0 ? payload.slice(0, queryIndex) : payload
    const queryPart = queryIndex >= 0 ? payload.slice(queryIndex + 1) : ''
    const params = new URLSearchParams(queryPart)
    const recipientCandidates = splitRecipients(pathPart)
    let subject = ''
    let bodyText = ''

    for (const [rawKey, rawValue] of params.entries()) {
        const key = rawKey.toLowerCase()

        if (key === 'to') {
            recipientCandidates.push(...splitRecipients(rawValue))
        } else if (key === 'subject' && !subject) {
            subject = rawValue
        } else if (key === 'body' && !bodyText) {
            bodyText = rawValue
        } else if (UNSUPPORTED_PARAMETERS.has(key)) {
            warnings.push({code: 'unsupported-parameter', parameter: key})
        }
    }

    const to = []
    const seen = new Set()

    for (const recipient of recipientCandidates) {
        const normalized = recipient.toLowerCase()
        if (!EMAIL_PATTERN.test(recipient)) {
            warnings.push({code: 'invalid-recipient', recipient})
            continue
        }
        if (!seen.has(normalized)) {
            seen.add(normalized)
            to.push(recipient)
        }
    }

    if (subject.length > MAX_MAILTO_SUBJECT_LENGTH) {
        subject = subject.slice(0, MAX_MAILTO_SUBJECT_LENGTH)
        warnings.push({code: 'subject-truncated'})
    }

    if (bodyText.length > MAX_MAILTO_BODY_LENGTH) {
        bodyText = bodyText.slice(0, MAX_MAILTO_BODY_LENGTH)
        warnings.push({code: 'body-truncated'})
    }

    return {to, subject, bodyText, warnings}
}

export function plainTextToSafeHtml(value) {
    return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;')
        .replace(/\r\n|\r|\n/g, '<br>')
}

export function storePendingMailto(uri) {
    if (typeof sessionStorage === 'undefined' || !uri) return
    sessionStorage.setItem(PENDING_MAILTO_KEY, String(uri))
}

export function takePendingMailto() {
    if (typeof sessionStorage === 'undefined') return ''
    const uri = sessionStorage.getItem(PENDING_MAILTO_KEY) || ''
    sessionStorage.removeItem(PENDING_MAILTO_KEY)
    return uri
}
