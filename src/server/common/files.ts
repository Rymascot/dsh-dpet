/**
 * Small filesystem helpers shared by the host modules.
 * @module dsh-dpet/server/common/files
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Write a file atomically (temp file + rename), creating parent directories. */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = file + '.' + process.pid + '.tmp'
  writeFileSync(temp, data)
  renameSync(temp, file)
}

/** The DSH home directory: $DSH_HOME when set, else ~/.dsh. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const raw = env.DSH_HOME?.trim()
  if (raw === undefined || raw === '') return join(home, '.dsh')
  const expanded = raw === '~' ? home : raw.startsWith('~/') || raw.startsWith('~\\') ? join(home, raw.slice(2)) : raw
  return isAbsolute(expanded) ? expanded : resolve(expanded)
}
