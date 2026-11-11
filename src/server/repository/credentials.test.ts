import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CredentialStore, credentialsFromEnv, describeCredentials, parseCredentials } from './credentials.ts'

const API_KEY = 'sk-test-0123456789abcd'
const SECRET_ID = 'testSecretId0123456789wxyz'
const SECRET_KEY = 'testSecretKey0123456789'

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'dpet-cred-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('parseCredentials', () => {
  it('accepts a TokenHub key and trims it', () => {
    expect(parseCredentials({ method: 'tokenhub', apiKey: '  ' + API_KEY + '\n' })).toEqual({ method: 'tokenhub', apiKey: API_KEY })
  })

  it('accepts a Tencent Cloud key with the default region', () => {
    expect(parseCredentials({ method: 'tencentcloud', secretId: SECRET_ID, secretKey: SECRET_KEY })).toEqual({
      method: 'tencentcloud', secretId: SECRET_ID, secretKey: SECRET_KEY, region: 'ap-guangzhou',
    })
  })

  it('rejects malformed input', () => {
    expect(parseCredentials({ method: 'tokenhub', apiKey: 'short' })).toBeUndefined()
    expect(parseCredentials({ method: 'tokenhub', apiKey: 'has a space inside' })).toBeUndefined()
    expect(parseCredentials({ method: 'tencentcloud', secretId: 'AKID-with-dash', secretKey: SECRET_KEY })).toBeUndefined()
    expect(parseCredentials({ method: 'tencentcloud', secretId: SECRET_ID, secretKey: SECRET_KEY, region: '../etc' })).toBeUndefined()
    expect(parseCredentials({ method: 'openai', apiKey: API_KEY })).toBeUndefined()
    expect(parseCredentials('nope')).toBeUndefined()
  })
})

describe('credentialsFromEnv', () => {
  it('prefers the TokenHub key, then the Tencent Cloud pair (with aliases)', () => {
    expect(credentialsFromEnv({ HUNYUAN_TOKENHUB_API_KEY: API_KEY, TENCENTCLOUD_SECRET_ID: SECRET_ID, TENCENTCLOUD_SECRET_KEY: SECRET_KEY }))
      .toEqual({ method: 'tokenhub', apiKey: API_KEY })
    expect(credentialsFromEnv({ HUNYUAN3D_SECRET_ID: SECRET_ID, HUNYUAN3D_SECRET_KEY: SECRET_KEY, TENCENTCLOUD_REGION: 'ap-shanghai' }))
      .toEqual({ method: 'tencentcloud', secretId: SECRET_ID, secretKey: SECRET_KEY, region: 'ap-shanghai' })
    expect(credentialsFromEnv({ TENCENTCLOUD_SECRET_ID: SECRET_ID })).toBeUndefined()
    expect(credentialsFromEnv({})).toBeUndefined()
  })
})

describe('describeCredentials', () => {
  it('never includes a secret', () => {
    const tokenhub = describeCredentials({ credentials: { method: 'tokenhub', apiKey: API_KEY }, source: 'local' })
    expect(tokenhub).toEqual({ configured: true, method: 'tokenhub', source: 'local', hint: '…abcd' })
    const cloud = describeCredentials({ credentials: { method: 'tencentcloud', secretId: SECRET_ID, secretKey: SECRET_KEY, region: 'ap-guangzhou' }, source: 'env' })
    expect(JSON.stringify(cloud)).not.toContain(SECRET_KEY)
    expect(JSON.stringify(cloud)).not.toContain(SECRET_ID)
    expect(cloud.hint).toBe('…wxyz')
    expect(describeCredentials(undefined)).toEqual({ configured: false })
  })
})

describe('CredentialStore', () => {
  it('saves, resolves before the environment, and clears', () => {
    withDir((dir) => {
      const file = join(dir, 'dpet', 'credentials.json')
      const store = new CredentialStore(file, { TENCENTCLOUD_SECRET_ID: SECRET_ID, TENCENTCLOUD_SECRET_KEY: SECRET_KEY })
      expect(store.resolve()?.source).toBe('env')
      store.save({ method: 'tokenhub', apiKey: API_KEY, extra: 'dropped' })
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ method: 'tokenhub', apiKey: API_KEY })
      expect(store.resolve()).toEqual({ credentials: { method: 'tokenhub', apiKey: API_KEY }, source: 'local' })
      store.clear()
      expect(existsSync(file)).toBe(false)
      expect(store.resolve()?.source).toBe('env')
    })
  })

  it('refuses invalid input and ignores a corrupt file', () => {
    withDir((dir) => {
      const file = join(dir, 'credentials.json')
      const store = new CredentialStore(file, {})
      expect(() => store.save({ method: 'tokenhub', apiKey: 'x' })).toThrow('invalid-credentials')
      writeFileSync(file, '{ not json')
      expect(store.resolve()).toBeUndefined()
    })
  })
})
