import { describe, expect, it } from 'vitest'
import { tc3Authorization, tc3Date, tc3Headers } from './tc3.ts'

// Expected values were produced by the official tencentcloud-sdk-nodejs-common
// Sign.sign3 with the same inputs (content-type + host signed). The ids and
// keys are made-up test strings, deliberately not shaped like real keys.
const VECTORS = [
  {
    secretId: 'TEST-ID-DOC-EXAMPLE',
    secretKey: 'test-key-not-real-0001',
    timestamp: 1551113065,
    payload: '{"Limit": 1, "Filters": [{"Values": ["未命名"], "Name": "instance-name"}]}',
    expected: 'TC3-HMAC-SHA256 Credential=TEST-ID-DOC-EXAMPLE/2019-02-25/ai3d/tc3_request, SignedHeaders=content-type;host, Signature=0694a850962a72bd3b093cfca2cd636a36de4f5749ba1d5fcd9e59c132fa1bdf',
  },
  {
    secretId: 'TEST-ID-SUBMIT',
    secretKey: 'secretXYZ987654',
    timestamp: 1762876800,
    payload: '{"ImageBase64":"aGVsbG8=","ResultFormat":"GLB"}',
    expected: 'TC3-HMAC-SHA256 Credential=TEST-ID-SUBMIT/2025-11-11/ai3d/tc3_request, SignedHeaders=content-type;host, Signature=923b0902626fd89b612c39134fffe55cda2f08d1103374c4218cf5b3f7bb2c77',
  },
  {
    secretId: 'TEST-ID-QUERY',
    secretKey: 'k+/=k12345678',
    timestamp: 1700000000,
    payload: '{"JobId":"0"}',
    expected: 'TC3-HMAC-SHA256 Credential=TEST-ID-QUERY/2023-11-14/ai3d/tc3_request, SignedHeaders=content-type;host, Signature=721ce3c7efa9f6df641a46e5af3ee61676909194a980b81db02c228a062e5402',
  },
]

describe('TC3 signing', () => {
  it('matches the official SDK', () => {
    for (const v of VECTORS) {
      const auth = tc3Authorization({
        secretId: v.secretId,
        secretKey: v.secretKey,
        service: 'ai3d',
        host: 'ai3d.tencentcloudapi.com',
        action: 'QueryHunyuanTo3DRapidJob',
        version: '2025-05-13',
        region: 'ap-guangzhou',
        payload: v.payload,
        timestamp: v.timestamp,
      })
      expect(auth).toBe(v.expected)
    }
  })

  it('uses the UTC date', () => {
    expect(tc3Date(0)).toBe('1970-01-01')
    expect(tc3Date(1762876799)).toBe('2025-11-11')
  })

  it('carries the action, version, region and timestamp headers', () => {
    const headers = tc3Headers({
      secretId: 'AKIDx', secretKey: 'keykeykey', service: 'ai3d', host: 'ai3d.tencentcloudapi.com',
      action: 'SubmitHunyuanTo3DRapidJob', version: '2025-05-13', region: 'ap-guangzhou', payload: '{}', timestamp: 1700000000,
    })
    expect(headers['X-TC-Action']).toBe('SubmitHunyuanTo3DRapidJob')
    expect(headers['X-TC-Version']).toBe('2025-05-13')
    expect(headers['X-TC-Region']).toBe('ap-guangzhou')
    expect(headers['X-TC-Timestamp']).toBe('1700000000')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.Authorization).toMatch(/^TC3-HMAC-SHA256 Credential=AKIDx\/2023-11-14\/ai3d\/tc3_request/)
  })
})
