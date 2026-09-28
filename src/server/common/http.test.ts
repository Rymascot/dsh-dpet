import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { accessProblem, isLoopbackAddress } from './http.ts'

function req(address: string, headers: Record<string, string>, method = 'GET'): IncomingMessage {
  return { socket: { remoteAddress: address }, headers, method } as unknown as IncomingMessage
}

describe('access control', () => {
  it('recognizes loopback addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.5')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })

  it('allows same-origin loopback requests', () => {
    expect(accessProblem(req('127.0.0.1', { host: '127.0.0.1:3080' }))).toBeUndefined()
    expect(accessProblem(req('127.0.0.1', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, 'POST'))).toBeUndefined()
  })

  it('refuses remote peers, foreign Host headers, and cross-origin writes', () => {
    expect(accessProblem(req('10.0.0.2', { host: '127.0.0.1:3080' }))).toBe('loopback-only')
    expect(accessProblem(req('127.0.0.1', { host: 'evil.example' }))).toBe('loopback-only')
    expect(accessProblem(req('127.0.0.1', { host: '127.0.0.1:3080', origin: 'https://evil.example' }, 'POST'))).toBe('cross-origin')
  })
})
