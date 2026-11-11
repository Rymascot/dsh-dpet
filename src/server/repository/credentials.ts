/**
 * Tencent Hunyuan 3D credentials, kept on this computer only.
 *
 * The user enters them on the settings page; they are saved to
 * `$DSH_HOME/dpet/credentials.json` (owner-only permissions where the OS
 * supports it) and only ever sent to Tencent Cloud. Environment variables
 * work too, for people who already keep their keys there:
 *
 *   HUNYUAN_TOKENHUB_API_KEY                      TokenHub API key
 *   TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY   Tencent Cloud API key
 *   (HUNYUAN3D_SECRET_ID / HUNYUAN3D_SECRET_KEY are accepted as aliases)
 *   TENCENTCLOUD_REGION                           optional, default ap-guangzhou
 *
 * Keys saved on the settings page win over the environment. Nothing here
 * ever returns a secret to the browser: {@link describeCredentials} gives
 * only the method and the last four characters of the key id.
 * @module dsh-dpet/server/repository/credentials
 */

import { readFileSync, rmSync } from 'node:fs'
import { writeFileAtomic } from '../common/files.ts'
import type { HunyuanStatus } from '../../shared/types.ts'

export type HunyuanCredentials =
  | { method: 'tokenhub'; apiKey: string }
  | { method: 'tencentcloud'; secretId: string; secretKey: string; region: string }

/** Where the credentials came from. */
export type CredentialSource = 'local' | 'env'

/** Default Tencent Cloud region of the ai3d API. */
export const DEFAULT_REGION = 'ap-guangzhou'

/** Printable ASCII without spaces. */
const TOKEN = /^[\x21-\x7e]{8,512}$/
const SECRET_ID = /^[A-Za-z0-9]{8,128}$/
const REGION = /^[a-z]{2,}(-[a-z]+)+(-\d+)?$/

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined
}

/** Validate untrusted credentials (from the page or the file); undefined when unusable. */
export function parseCredentials(raw: unknown): HunyuanCredentials | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (r.method === 'tokenhub') {
    const apiKey = text(r.apiKey)
    return apiKey !== undefined && TOKEN.test(apiKey) ? { method: 'tokenhub', apiKey } : undefined
  }
  if (r.method === 'tencentcloud') {
    const secretId = text(r.secretId)
    const secretKey = text(r.secretKey)
    const region = text(r.region) || DEFAULT_REGION
    if (secretId === undefined || !SECRET_ID.test(secretId)) return undefined
    if (secretKey === undefined || !TOKEN.test(secretKey)) return undefined
    if (!REGION.test(region)) return undefined
    return { method: 'tencentcloud', secretId, secretKey, region }
  }
  return undefined
}

/** Credentials from environment variables, if any. */
export function credentialsFromEnv(env: NodeJS.ProcessEnv): HunyuanCredentials | undefined {
  const apiKey = text(env.HUNYUAN_TOKENHUB_API_KEY)
  if (apiKey) return parseCredentials({ method: 'tokenhub', apiKey })
  const secretId = text(env.TENCENTCLOUD_SECRET_ID) || text(env.HUNYUAN3D_SECRET_ID)
  const secretKey = text(env.TENCENTCLOUD_SECRET_KEY) || text(env.HUNYUAN3D_SECRET_KEY)
  if (secretId && secretKey) {
    return parseCredentials({ method: 'tencentcloud', secretId, secretKey, region: text(env.TENCENTCLOUD_REGION) })
  }
  return undefined
}

/** The last four characters of the key id, for "connected as …a1b2". */
export function hintOf(credentials: HunyuanCredentials): string {
  const id = credentials.method === 'tokenhub' ? credentials.apiKey : credentials.secretId
  return '…' + id.slice(-4)
}

/** Browser-safe description (no secrets). */
export function describeCredentials(resolved: { credentials: HunyuanCredentials; source: CredentialSource } | undefined): HunyuanStatus {
  if (resolved === undefined) return { configured: false }
  const { credentials, source } = resolved
  return {
    configured: true,
    method: credentials.method,
    source,
    hint: hintOf(credentials),
    ...(credentials.method === 'tencentcloud' ? { region: credentials.region } : {}),
  }
}

export class CredentialStore {
  constructor(private readonly file: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** Saved credentials first, then the environment. */
  resolve(): { credentials: HunyuanCredentials; source: CredentialSource } | undefined {
    try {
      const saved = parseCredentials(JSON.parse(readFileSync(this.file, 'utf8')))
      if (saved !== undefined) return { credentials: saved, source: 'local' }
    } catch {}
    const fromEnv = credentialsFromEnv(this.env)
    return fromEnv === undefined ? undefined : { credentials: fromEnv, source: 'env' }
  }

  /** Validate and save credentials entered on the settings page. */
  save(raw: unknown): HunyuanCredentials {
    const credentials = parseCredentials(raw)
    if (credentials === undefined) throw new Error('invalid-credentials')
    writeFileAtomic(this.file, JSON.stringify(credentials, null, 2) + '\n', 0o600)
    return credentials
  }

  /** Forget the saved credentials (environment variables are untouched). */
  clear(): void {
    rmSync(this.file, { force: true })
  }
}
