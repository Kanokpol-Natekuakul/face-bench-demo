import { useEffect, useRef, useState } from 'react'

export type Pose = 'front' | 'left' | 'right' | 'up' | 'down'

const words: Record<Pose, string> = { front: 'มองตรง', left: 'หันซ้าย ←', right: 'หันขวา →', up: 'เงยหน้า ↑', down: 'ก้มหน้า ↓' }

function useCamera() {
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')

  const stop = () => stream.current?.getTracks().forEach(track => track.stop())

  useEffect(() => {
    let gone = false
    const start = async () => {
      try {
        stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
        if (gone) stop()
        else if (video.current) video.current.srcObject = stream.current
      } catch (e) {
        if (!gone) setError(e instanceof DOMException && e.name === 'NotAllowedError' ? 'ไม่ได้รับอนุญาตให้ใช้กล้อง เปิดสิทธิ์กล้องให้เว็บนี้ในการตั้งค่าเบราว์เซอร์ แล้วลองใหม่' : 'เปิดกล้องไม่ได้ ตรวจว่าเครื่องมีกล้องและไม่มีแอปอื่นใช้อยู่')
      }
    }
    start()
    return () => {
      gone = true
      stop()
    }
  }, [])

  const view = <video ref={video} aria-label="ภาพจากกล้อง" playsInline muted autoPlay onLoadedData={() => setReady(true)} />
  return { video, view, ready, setReady, error, stop }
}

function draw(v: HTMLVideoElement, max: number) {
  const canvas = document.createElement('canvas')
  const scale = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight))
  canvas.width = Math.round(v.videoWidth * scale)
  canvas.height = Math.round(v.videoHeight * scale)
  canvas.getContext('2d')?.drawImage(v, 0, 0, canvas.width, canvas.height)
  return canvas
}

export function Camera({ onShot, onCancel }: { onShot: (photo: Blob | null) => void; onCancel: () => void }) {
  const { video, view, ready, setReady, error, stop } = useCamera()
  const cancelled = useRef(false)

  function shoot() {
    const v = video.current
    if (!v?.videoWidth) return
    setReady(false)
    const canvas = draw(v, 1280)
    stop()
    canvas.toBlob(blob => cancelled.current || onShot(blob), 'image/jpeg', 0.9)
  }

  return (
    <section>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <>
          <p className="meta">มองกล้องตรง ๆ ในที่สว่าง แล้วกด “ถ่าย”</p>
          {view}
        </>
      )}
      <div className="row">
        <button className="primary" disabled={!ready} onClick={shoot}>
          ถ่าย
        </button>
        <button
          onClick={() => {
            cancelled.current = true
            stop()
            onCancel()
          }}
        >
          ยกเลิก
        </button>
      </div>
    </section>
  )
}

export function Guided({ steps, shutter = false, onDone, onCancel }: { steps: Pose[]; shutter?: boolean; onDone: (frames: Blob[] | null) => void; onCancel: () => void }) {
  const { video, view, ready, error, stop } = useCamera()
  const [step, setStep] = useState(-1)
  const timer = useRef(0)
  const gone = useRef(false)
  const pose: Pose | undefined = steps[step]
  const asked = pose ?? (shutter ? steps[0] : undefined)

  const halt = () => {
    gone.current = true
    clearTimeout(timer.current)
    stop()
  }

  useEffect(() => halt, [])

  async function run() {
    const frames: (Blob | null)[] = []
    for (let i = 0; i < steps.length; i++) {
      setStep(i)
      const photo = shutter && i === 0
      if (!photo) await new Promise(done => (timer.current = window.setTimeout(done, 1500)))
      frames.push(await new Promise<Blob | null>(done => draw(video.current!, photo ? 1280 : 640).toBlob(done, 'image/jpeg', 0.9)))
      if (gone.current) return
    }
    stop()
    onDone(frames.every((frame): frame is Blob => frame !== null) ? frames : null)
  }

  return (
    <section>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <>
          <p className={pose ? 'step' : 'meta'} role="status" data-step={asked}>
            {pose
              ? words[pose]
              : shutter
                ? `มองกล้องตรง ๆ แล้วกด “ถ่ายรูป” รูปนี้คือรูปเช็คอินที่เก็บไว้ จากนั้นหันหน้าตามคำสั่งอีก ${steps.length - 1} ท่า ประมาณ 1.5 วินาที`
                : `จะให้หันหน้าตามคำสั่ง ${steps.length} ท่า ท่าละประมาณ 1.5 วินาที ถือมือถือให้หน้าอยู่กลางจอ แล้วกด “เริ่มถ่าย”`}
          </p>
          {pose && <p className="meta">{shutter ? 'ถ่ายรูปแล้ว ค้างท่าไว้จนกล้องปิด' : `ท่า ${step + 1}/${steps.length}`}</p>}
          {view}
        </>
      )}
      <div className="row">
        {!pose && (
          <button className="primary" disabled={!ready} onClick={run}>
            {shutter ? 'ถ่ายรูป' : 'เริ่มถ่าย'}
          </button>
        )}
        <button
          onClick={() => {
            halt()
            onCancel()
          }}
        >
          ยกเลิก
        </button>
      </div>
    </section>
  )
}
