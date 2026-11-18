import { useEffect, useRef, useState } from 'react'

export function Camera({ onShot, onCancel }: { onShot: (photo: Blob | null) => void; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const cancelled = useRef(false)
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

  function shoot() {
    const v = video.current
    if (!v?.videoWidth) return
    setReady(false)
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight))
    canvas.width = Math.round(v.videoWidth * scale)
    canvas.height = Math.round(v.videoHeight * scale)
    canvas.getContext('2d')?.drawImage(v, 0, 0, canvas.width, canvas.height)
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
          <video ref={video} aria-label="ภาพจากกล้อง" playsInline muted autoPlay onLoadedData={() => setReady(true)} />
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
