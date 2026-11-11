/**
 * Tencent Cloud API 3.0 request signing (TC3-HMAC-SHA256), written from the
 * official "签名方法 v3" document. Signs the content-type and host headers,
 * the same set the official SDK signs.
 * @module dsh-dpet/server/service/hunyuan/tc3
 */

import { createHash, createHmac } from 'node:crypto'

export interface Tc3Request {
  secretId: string
  secretKey: string
  /** Service name, e.g. "ai3d". */
  service: string
  /** API host, e.g. "ai3d.tencentcloudapi.com". */
  host: string
  action: string
  version: string
  region: string
  /** The exact JSON body that will be sent. */
  payload: string
  /** Unix seconds. */
  timestamp: number
}

export const TC3_CONTENT_TYPE = 'application/json'

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/** UTC calendar date of a Unix timestamp, YYYY-MM-DD. */
export function tc3Date(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10)
}

/** The Authorization header value. */
export function tc3Authorization(req: Tc3Request): string {
  const signedHeaders = 'content-type;host'
  const canonicalRequest = [
    'POST',
    '/',
    '',
    'content-type:' + TC3_CONTENT_TYPE + '\nhost:' + req.host + '\n',
    signedHeaders,
    sha256Hex(req.payload),
  ].join('\n')
  const date = tc3Date(req.timestamp)
  const scope = date + '/' + req.service + '/tc3_request'
  const stringToSign = ['TC3-HMAC-SHA256', String(req.timestamp), scope, sha256Hex(canonicalRequest)].join('\n')
  const secretDate = hmac('TC3' + req.secretKey, date)
  const secretService = hmac(secretDate, req.service)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex')
  return 'TC3-HMAC-SHA256 Credential=' + req.secretId + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature
}

/** Every header a signed request carries (fetch adds Host from the URL). */
export function tc3Headers(req: Tc3Request): Record<string, string> {
  return {
    'Authorization': tc3Authorization(req),
    'Content-Type': TC3_CONTENT_TYPE,
    'X-TC-Action': req.action,
    'X-TC-Timestamp': String(req.timestamp),
    'X-TC-Version': req.version,
    'X-TC-Region': req.region,
  }
}
