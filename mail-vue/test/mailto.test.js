import test from 'node:test'
import assert from 'node:assert/strict'
import {
    MAX_MAILTO_BODY_LENGTH,
    MAX_MAILTO_SUBJECT_LENGTH,
    parseMailto,
    plainTextToSafeHtml,
} from '../src/utils/mailto.js'

test('parses a standard mailto URI', () => {
    assert.deepEqual(
        parseMailto('mailto:test@example.com?subject=Hello&body=World'),
        {to: ['test@example.com'], subject: 'Hello', bodyText: 'World', warnings: []},
    )
})

test('parses, validates and deduplicates multiple recipients', () => {
    const result = parseMailto('mailto:First@example.com,second@example.com?to=first@example.com,invalid')
    assert.deepEqual(result.to, ['First@example.com', 'second@example.com'])
    assert.deepEqual(result.warnings, [{code: 'invalid-recipient', recipient: 'invalid'}])
})

test('decodes Chinese subject and multiline body', () => {
    const result = parseMailto('mailto:test@example.com?subject=%E6%B5%8B%E8%AF%95%E4%B8%BB%E9%A2%98&body=%E7%AC%AC%E4%B8%80%E8%A1%8C%0A%E7%AC%AC%E4%BA%8C%E8%A1%8C')
    assert.equal(result.subject, '测试主题')
    assert.equal(result.bodyText, '第一行\n第二行')
})

test('handles missing fields', () => {
    assert.deepEqual(parseMailto('mailto:'), {to: [], subject: '', bodyText: '', warnings: []})
})

test('keeps cc, bcc and attachments out of recipients', () => {
    const result = parseMailto('mailto:to@example.com?cc=cc@example.com&bcc=bcc@example.com&attachment=file.txt')
    assert.deepEqual(result.to, ['to@example.com'])
    assert.deepEqual(result.warnings, [
        {code: 'unsupported-parameter', parameter: 'cc'},
        {code: 'unsupported-parameter', parameter: 'bcc'},
        {code: 'unsupported-parameter', parameter: 'attachment'},
    ])
})

test('escapes malicious HTML before inserting line breaks', () => {
    assert.equal(
        plainTextToSafeHtml('<img src=x onerror=alert(1)>\n<script>alert(2)</script>'),
        '&lt;img src=x onerror=alert(1)&gt;<br>&lt;script&gt;alert(2)&lt;/script&gt;',
    )
})

test('accepts an encoded complete mailto URI', () => {
    const result = parseMailto('mailto%3Atest%40example.com%3Fsubject%3DEncoded')
    assert.equal(result.to[0], 'test@example.com')
    assert.equal(result.subject, 'Encoded')
})

test('splits percent-encoded recipient separators', () => {
    const result = parseMailto('mailto:first%40example.com%2Csecond%40example.com')
    assert.deepEqual(result.to, ['first@example.com', 'second@example.com'])
})

test('rejects non-mailto input', () => {
    assert.deepEqual(parseMailto('https://example.com'), {
        to: [],
        subject: '',
        bodyText: '',
        warnings: [{code: 'invalid-uri'}],
    })
})

test('truncates overlong subject and body with warnings', () => {
    const result = parseMailto(`mailto:test@example.com?subject=${'s'.repeat(MAX_MAILTO_SUBJECT_LENGTH + 1)}&body=${'b'.repeat(MAX_MAILTO_BODY_LENGTH + 1)}`)
    assert.equal(result.subject.length, MAX_MAILTO_SUBJECT_LENGTH)
    assert.equal(result.bodyText.length, MAX_MAILTO_BODY_LENGTH)
    assert.deepEqual(result.warnings, [{code: 'subject-truncated'}, {code: 'body-truncated'}])
})
