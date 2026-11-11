import { describe, expect, it } from 'vitest'
import { generationLine, generationPhase } from './lines.ts'

describe('generation on the floating pet', () => {
  it('thinks while a job runs, cheers when done, droops on failure', () => {
    expect(generationPhase(undefined)).toBeUndefined()
    expect(generationPhase({ name: 'x', status: 'queued' })).toBe('thinking')
    expect(generationPhase({ name: 'x', status: 'importing' })).toBe('thinking')
    expect(generationPhase({ name: 'x', status: 'done', petId: 'x' })).toBe('done')
    expect(generationPhase({ name: 'x', status: 'failed' })).toBe('failed')
  })

  it('names the job in the bubble', () => {
    expect(generationLine(undefined)).toBeUndefined()
    expect(generationLine({ name: '小蓝', status: 'running' })).toBe('正在生成 3D 形象「小蓝」…')
    expect(generationLine({ name: '小蓝', status: 'done' })).toBe('3D 形象「小蓝」生成好了！')
    expect(generationLine({ name: '小蓝', status: 'failed' })).toBe('「小蓝」没生成成功')
  })
})
