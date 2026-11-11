import { describe, expect, it } from 'vitest'
import {
  AI3D_HOST,
  HunyuanError,
  TOKENHUB_BASE,
  downloadBytes,
  pickGlb,
  tencentCloudClient,
  tencentCloudError,
  tokenHubClient,
  tokenHubError,
  type FetchLike,
} from './client.ts'

interface Call { url: string; init: RequestInit | undefined }

/** A fetch that records calls and answers from a list. */
function fakeFetch(answers: Array<Response | Error>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      const answer = answers.shift()
      if (answer === undefined) throw new Error('no more answers')
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error instanceof HunyuanError ? error.code : 'other:' + String(error)
  }
}

describe('pickGlb', () => {
  it('finds the GLB in either casing', () => {
    expect(pickGlb([{ type: 'obj', url: 'https://x/a.zip' }, { type: 'glb', url: 'https://x/a.glb' }])).toBe('https://x/a.glb')
    expect(pickGlb([{ Type: 'GLB', Url: 'https://x/b.glb' }])).toBe('https://x/b.glb')
    expect(pickGlb([{ Type: 'OBJ', Url: 'https://x/b.zip' }])).toBeUndefined()
    expect(pickGlb(undefined)).toBeUndefined()
  })
})

describe('TokenHub client', () => {
  it('submits the picture with the model and GLB output for rapid', async () => {
    const { fetch, calls } = fakeFetch([json({ id: '1472', status: 'queued' })])
    const id = await tokenHubClient('sk-key', fetch).submit('aGVsbG8=', 'rapid')
    expect(id).toBe('1472')
    expect(calls[0]!.url).toBe(TOKENHUB_BASE + '/submit')
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-key')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ model: 'hy-3d-express', image_base64: 'aGVsbG8=', result_format: 'glb' })
  })

  it('uses hy-3d-3.0 without a result format for pro', async () => {
    const { fetch, calls } = fakeFetch([json({ id: 'p1' })])
    await tokenHubClient('sk-key', fetch).submit('aGVsbG8=', 'pro')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ model: 'hy-3d-3.0', image_base64: 'aGVsbG8=' })
  })

  it('normalizes query states', async () => {
    const { fetch } = fakeFetch([
      json({ status: 'queued' }),
      json({ status: 'in_progress' }),
      json({ status: 'completed', data: [{ type: 'obj', url: 'https://c/x.zip' }, { type: 'glb', url: 'https://c/x.glb', preview_image_url: 'https://c/x.png' }] }),
      json({ status: 'failed', error: { code: 'ContentRisk', message: 'blocked' } }),
    ])
    const client = tokenHubClient('sk-key', fetch)
    expect(await client.query('1', 'rapid')).toEqual({ state: 'queued' })
    expect(await client.query('1', 'rapid')).toEqual({ state: 'running' })
    expect(await client.query('1', 'rapid')).toEqual({ state: 'done', glbUrl: 'https://c/x.glb' })
    expect(await client.query('1', 'rapid')).toEqual({ state: 'failed', code: 'ContentRisk', message: 'blocked' })
  })

  it('maps HTTP errors', async () => {
    const { fetch } = fakeFetch([
      json({ error: { code: '401002', message: 'The API Key does not exist' } }, 401),
      json({ error: { message: 'too many' } }, 429),
      new TypeError('fetch failed'),
    ])
    const client = tokenHubClient('sk-key', fetch)
    expect(await codeOf(client.submit('x', 'rapid'))).toBe('unauthorized')
    expect(await codeOf(client.submit('x', 'rapid'))).toBe('rate-limited')
    expect(await codeOf(client.submit('x', 'rapid'))).toBe('network')
  })

  it('check passes when only the job id is rejected', async () => {
    const ok = fakeFetch([json({ error: { message: 'job not found' } }, 404)])
    await expect(tokenHubClient('sk-key', ok.fetch).check()).resolves.toBeUndefined()
    const bad = fakeFetch([json({ error: { message: 'bad key' } }, 401)])
    expect(await codeOf(tokenHubClient('sk-key', bad.fetch).check())).toBe('unauthorized')
  })

  it('reads quota and rate words in error bodies', () => {
    expect(tokenHubError(400, { error: { message: '账户余额不足' } }).code).toBe('quota')
    expect(tokenHubError(400, { error: { code: 'ConcurrencyLimit' } }).code).toBe('rate-limited')
    expect(tokenHubError(503, {}).code).toBe('remote-error')
    expect(tokenHubError(400, { error: { message: 'image too small' } }).code).toBe('rejected')
  })
})

describe('Tencent Cloud client', () => {
  const credentials = { secretId: 'AKIDtest', secretKey: 'secretkey123', region: 'ap-guangzhou' }

  it('signs and submits a rapid job with GLB output', async () => {
    const { fetch, calls } = fakeFetch([json({ Response: { JobId: '1335', RequestId: 'r' } })])
    const id = await tencentCloudClient(credentials, fetch, () => 1700000000_000).submit('aGVsbG8=', 'rapid')
    expect(id).toBe('1335')
    expect(calls[0]!.url).toBe('https://' + AI3D_HOST + '/')
    const headers = calls[0]!.init!.headers as Record<string, string>
    expect(headers['X-TC-Action']).toBe('SubmitHunyuanTo3DRapidJob')
    expect(headers['X-TC-Version']).toBe('2025-05-13')
    expect(headers['X-TC-Timestamp']).toBe('1700000000')
    expect(headers.Authorization).toContain('Credential=AKIDtest/2023-11-14/ai3d/tc3_request')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ ImageBase64: 'aGVsbG8=', ResultFormat: 'GLB' })
  })

  it('uses the pro actions', async () => {
    const { fetch, calls } = fakeFetch([json({ Response: { JobId: '9' } }), json({ Response: { Status: 'RUN' } })])
    const client = tencentCloudClient(credentials, fetch)
    await client.submit('aGVsbG8=', 'pro')
    await client.query('9', 'pro')
    expect((calls[0]!.init!.headers as Record<string, string>)['X-TC-Action']).toBe('SubmitHunyuanTo3DProJob')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ ImageBase64: 'aGVsbG8=' })
    expect((calls[1]!.init!.headers as Record<string, string>)['X-TC-Action']).toBe('QueryHunyuanTo3DProJob')
  })

  it('normalizes query states', async () => {
    const { fetch } = fakeFetch([
      json({ Response: { Status: 'WAIT' } }),
      json({ Response: { Status: 'RUN' } }),
      json({ Response: { Status: 'DONE', ResultFile3Ds: [{ Type: 'GLB', Url: 'https://cos/x.glb', PreviewImageUrl: 'https://cos/x.png' }] } }),
      json({ Response: { Status: 'FAIL', ErrorCode: 'FailedOperation.InnerError', ErrorMessage: '服务内部错误' } }),
    ])
    const client = tencentCloudClient(credentials, fetch)
    expect(await client.query('1', 'rapid')).toEqual({ state: 'queued' })
    expect(await client.query('1', 'rapid')).toEqual({ state: 'running' })
    expect(await client.query('1', 'rapid')).toEqual({ state: 'done', glbUrl: 'https://cos/x.glb' })
    expect(await client.query('1', 'rapid')).toEqual({ state: 'failed', code: 'FailedOperation.InnerError', message: '服务内部错误' })
  })

  it('maps Response.Error codes', async () => {
    const { fetch } = fakeFetch([json({ Response: { Error: { Code: 'AuthFailure.SecretIdNotFound', Message: 'not found' } } })])
    const error = await tencentCloudClient(credentials, fetch).submit('x', 'rapid').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HunyuanError)
    expect((error as HunyuanError).code).toBe('unauthorized')
    expect((error as HunyuanError).detail).toBe('AuthFailure.SecretIdNotFound: not found')
    expect(tencentCloudError('UnauthorizedOperation.NotOpened', undefined).code).toBe('forbidden')
    expect(tencentCloudError('LimitExceeded.JobNumExceed', undefined).code).toBe('rate-limited')
    expect(tencentCloudError('ResourceUnavailable.NotExist', undefined).code).toBe('quota')
    expect(tencentCloudError('InvalidParameterValue.ImageSize', undefined).code).toBe('rejected')
    expect(tencentCloudError('InternalError', undefined).code).toBe('remote-error')
  })

  it('check passes on InvalidParameter and fails on AuthFailure', async () => {
    const ok = fakeFetch([json({ Response: { Error: { Code: 'InvalidParameter', Message: 'JobId' } } })])
    await expect(tencentCloudClient(credentials, ok.fetch).check()).resolves.toBeUndefined()
    const bad = fakeFetch([json({ Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: 'x' } } })])
    expect(await codeOf(tencentCloudClient(credentials, bad.fetch).check())).toBe('unauthorized')
  })
})

describe('downloadBytes', () => {
  it('downloads over https within the limit', async () => {
    const { fetch } = fakeFetch([new Response(new Uint8Array([1, 2, 3]))])
    expect([...await downloadBytes(fetch, 'https://cos/x.glb', 10)]).toEqual([1, 2, 3])
  })

  it('refuses http, oversized files, and HTTP errors', async () => {
    expect(await codeOf(downloadBytes(fakeFetch([]).fetch, 'http://cos/x.glb', 10))).toBe('remote-error')
    expect(await codeOf(downloadBytes(fakeFetch([new Response(new Uint8Array(20))]).fetch, 'https://cos/x.glb', 10))).toBe('download-too-large')
    expect(await codeOf(downloadBytes(fakeFetch([new Response('no', { status: 403 })]).fetch, 'https://cos/x.glb', 10))).toBe('remote-error')
  })
})
