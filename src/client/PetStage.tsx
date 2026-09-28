/**
 * PetStage — mounts the right renderer (3D model or 2D picture) for one pet
 * and keeps it in sync with React props. The floating pet and the settings
 * preview both render through it, so a pet looks and moves the same in both.
 * @module dsh-dpet/client/PetStage
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { ActivityPhase, PetMotion, PetView } from '../types.ts'
import { createPhaseStream, type PhaseStream } from './phase-stream.ts'
import { mountFlat, type PetErrorCode, type PetHandle } from './renderers/flat.ts'
import { mountGltf } from './renderers/gltf.ts'
import { t } from './i18n.ts'

export interface PetStageProps {
  pet: PetView
  phase: ActivityPhase
  motions?: Partial<Record<ActivityPhase, PetMotion>>
  lookAtCursor?: boolean
  className?: string
  style?: CSSProperties
  /** Receives the live handle (undefined on teardown). */
  onHandle?: (handle: PetHandle | undefined) => void
  /** Called once the pet is on screen. */
  onReady?: (handle: PetHandle) => void
  /** Distance in px from the stage top to the pet's head, after each layout. */
  onLayout?: (headTopPx: number) => void
}

export function PetStage(props: PetStageProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const streamRef = useRef<PhaseStream | null>(null)
  const handleRef = useRef<PetHandle | undefined>(undefined)
  const [error, setError] = useState<PetErrorCode | null>(null)
  const latest = useRef(props)
  latest.current = props

  // One renderer activation per pet file.
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return undefined
    setError(null)
    streamRef.current ??= createPhaseStream(props.phase)
    const common = {
      container,
      phase: streamRef.current,
      ...(latest.current.motions === undefined ? {} : { motions: latest.current.motions }),
      lookAtCursor: latest.current.lookAtCursor ?? true,
    }
    const handle = props.pet.kind === '3d'
      ? mountGltf({ ...common, modelUrl: props.pet.fileUrl })
      : mountFlat({ ...common, imageUrl: props.pet.fileUrl })
    handleRef.current = handle
    handle.onError(setError)
    handle.onReady(() => latest.current.onReady?.(handle))
    handle.onLayout(top => latest.current.onLayout?.(top))
    latest.current.onHandle?.(handle)
    return () => {
      handleRef.current = undefined
      latest.current.onHandle?.(undefined)
      handle.dispose()
    }
  }, [props.pet.kind, props.pet.fileUrl])

  useEffect(() => { streamRef.current?.push(props.phase) }, [props.phase])
  useEffect(() => { handleRef.current?.setMotions(props.motions) }, [JSON.stringify(props.motions ?? {})])
  useEffect(() => { handleRef.current?.setLookAtCursor(props.lookAtCursor ?? true) }, [props.lookAtCursor])

  return (
    <div
      ref={containerRef}
      className={props.className}
      // A className owns positioning (the settings stage is absolutely placed);
      // without one the stage is a plain relative box.
      style={props.className === undefined ? { position: 'relative', ...props.style } : props.style}
      data-dpet-stage={props.pet.id}
    >
      {error !== null && (
        <span style={{ position: 'absolute', inset: 'auto 8px 8px', fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #d92d20)' }}>
          {error === 'vendor-missing' ? t('stage.vendorMissing') : t('stage.loadFailed')}
        </span>
      )}
    </div>
  )
}
