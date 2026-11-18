import type { Session } from '@supabase/supabase-js'
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { supabase, url } from './supabase'

type Action = 'enroll' | 'checkin'
type Checkin = { id: number; created_at: string; status: string; reason: string | null; similarity: number | null; live: number | null }

const errors: Record<string, string> = {
  no_face: 'ไม่พบใบหน้า ลองใหม่ในที่สว่าง หน้าตรง',
  spoof: 'ดูเหมือนรูปถ่ายหรือหน้าจอ ลองถ่ายใหม่',
  bad_image: 'อ่านรูปไม่ได้ ลองใหม่',
  not_enrolled: 'ยังไม่ได้ลงทะเบียนใบหน้า',
  too_large: 'รูปใหญ่เกินไป ลองใหม่',
  unauthorized: 'เซสชันหมดอายุ ออกจากระบบแล้วเข้าใหม่',
}

const reasons: Record<string, string> = {
  no_face: 'ไม่พบใบหน้า',
  spoof: 'อาจเป็นรูปถ่าย/หน้าจอ',
  mismatch: 'หน้าไม่ตรงกับที่ลงทะเบียน',
}

const authErrors: Record<string, string> = {
  invalid_credentials: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
  email_not_confirmed: 'ยังไม่ได้ยืนยันอีเมล กดลิงก์ในอีเมลก่อน',
  user_already_exists: 'อีเมลนี้สมัครไว้แล้ว',
  weak_password: 'รหัสผ่านง่ายเกินไป',
  over_email_send_rate_limit: 'ส่งอีเมลถี่เกินไป รอสักครู่แล้วลองใหม่',
}

const say = (map: Record<string, string>, key: unknown) => (typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : '')
const when = (iso: string) => new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' })
const two = (n: unknown) => (typeof n === 'number' ? n.toFixed(2) : null)

function App() {
  const [session, setSession] = useState<Session | null>()

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => data.subscription.unsubscribe()
  }, [])

  return (
    <>
      <h1>Face Check-in (ทดสอบ)</h1>
      {session === null && <Login />}
      {session && <Home key={session.user.id} session={session} />}
    </>
  )
}

function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function go(signUp: boolean) {
    setBusy(true)
    setMsg('')
    const { data, error } = signUp ? await supabase.auth.signUp({ email, password }) : await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) setMsg(say(authErrors, error.code) || `ไม่สำเร็จ: ${error.message}`)
    else if (!data.session) setMsg('ส่งอีเมลยืนยันแล้ว กดลิงก์ในอีเมล แล้วกลับมาเข้าสู่ระบบ')
  }

  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        go(false)
      }}
    >
      <label>
        อีเมล
        <input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} />
      </label>
      <label>
        รหัสผ่าน
        <input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
      </label>
      <div className="row">
        <button className="primary" disabled={busy}>เข้าสู่ระบบ</button>
        <button type="button" disabled={busy} onClick={e => e.currentTarget.form?.reportValidity() && go(true)}>
          สมัครสมาชิก
        </button>
      </div>
      <p className="msg" role="status">{msg}</p>
    </form>
  )
}

function Home({ session }: { session: Session }) {
  const [enrolledAt, setEnrolledAt] = useState<string | null>()
  const [history, setHistory] = useState<Checkin[]>([])
  const [again, setAgain] = useState(false)
  const [consent, setConsent] = useState(false)
  const [camera, setCamera] = useState<Action | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Checkin | null>(null)
  const [msg, setMsg] = useState('')
  const req = useRef(0)

  async function load() {
    const [enrollments, checkins] = await Promise.all([
      supabase.from('face_enrollments').select('id, created_at').order('id', { ascending: false }).limit(1),
      supabase.from('face_checkins').select('id, created_at, status, reason, similarity, live').order('created_at', { ascending: false }).limit(20),
    ])
    if (enrollments.error || checkins.error) {
      setMsg('โหลดข้อมูลไม่ได้ ลองรีเฟรชหน้า')
      return
    }
    setEnrolledAt(enrollments.data[0]?.created_at ?? null)
    setHistory(checkins.data)
  }

  useEffect(() => {
    load()
  }, [])

  function begin() {
    req.current++
    setResult(null)
    setMsg('')
  }

  function open(action: Action) {
    begin()
    setCamera(action)
  }

  async function submit(action: Action, photo: Blob | null) {
    setCamera(null)
    const n = req.current
    if (!photo || photo.size >= 2_000_000) {
      setMsg(errors[photo ? 'too_large' : 'bad_image'])
      return
    }
    setBusy(true)
    try {
      const { data } = await supabase.auth.getSession()
      const res = await fetch(`${url}/functions/v1/face-checkin?action=${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${data.session?.access_token}`, 'Content-Type': 'image/jpeg' },
        body: photo,
        signal: AbortSignal.timeout(20_000),
      })
      const body = await res.json()
      if (n !== req.current) return
      if (!res.ok) setMsg(say(errors, body?.error) || 'ระบบขัดข้อง ลองใหม่ภายหลัง')
      else if (action === 'checkin') setResult(body)
      else {
        setAgain(false)
        setConsent(false)
        setMsg('ลงทะเบียนใบหน้าแล้ว')
      }
      if (res.ok || res.status === 409) await load()
    } catch {
      if (n === req.current) setMsg('เชื่อมต่อไม่ได้หรือรอนานเกินไป ลองใหม่อีกครั้ง')
    } finally {
      if (n === req.current) setBusy(false)
    }
  }

  async function forget() {
    if (!window.confirm('ลบข้อมูลใบหน้า? ต้องลงทะเบียนใหม่ก่อนเช็คอินครั้งต่อไป')) return
    begin()
    const n = req.current
    setBusy(true)
    const { error } = await supabase.from('face_enrollments').delete().eq('user_id', session.user.id)
    if (n !== req.current) return
    if (error) setMsg('ลบไม่สำเร็จ ลองใหม่')
    else {
      setAgain(false)
      setConsent(false)
      await load()
    }
    setBusy(false)
  }

  return (
    <>
      <div className="row top">
        <span>{session.user.email}</span>
        <button onClick={() => supabase.auth.signOut()}>ออกจากระบบ</button>
      </div>
      {camera ? (
        <Camera onShot={photo => submit(camera, photo)} onCancel={() => setCamera(null)} />
      ) : (
        <>
          {enrolledAt && (
            <section>
              <p>ลงทะเบียนเมื่อ {when(enrolledAt)}</p>
              <div className="row">
                <button className="primary" disabled={busy} onClick={() => open('checkin')}>
                  เช็คอิน
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    begin()
                    setAgain(true)
                    setConsent(false)
                  }}
                >
                  ลงทะเบียนใหม่
                </button>
                <button disabled={busy} onClick={forget}>
                  ลบข้อมูลใบหน้า
                </button>
              </div>
            </section>
          )}
          {(enrolledAt === null || again) && (
            <section>
              <h2>ขอความยินยอมใช้ข้อมูลใบหน้า</h2>
              <ul>
                <li>ระบบจะแปลงใบหน้าเป็นตัวเลข 128 ค่าเก็บไว้เทียบตอนเช็คอิน ไม่เก็บรูป</li>
                <li>ข้อมูลใบหน้าเป็นข้อมูลชีวภาพตาม PDPA ม.26 จึงต้องขอความยินยอม</li>
                <li>ลบได้ทุกเมื่อด้วยปุ่ม “ลบข้อมูลใบหน้า”</li>
              </ul>
              <label className="check">
                <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
                ยินยอมให้ใช้ข้อมูลใบหน้าเพื่อเช็คอิน
              </label>
              <button className="primary" disabled={!consent || busy} onClick={() => open('enroll')}>
                ลงทะเบียนใบหน้า
              </button>
            </section>
          )}
        </>
      )}
      <p className="msg" role="status">
        {busy ? 'กำลังตรวจ…' : msg || (enrolledAt === undefined ? 'กำลังโหลด…' : '')}
      </p>
      {result && (
        <section>
          <p className={result.status === 'pass' ? 'verdict ok' : 'verdict warn'}>
            {result.status === 'pass' ? 'ผ่าน ✓' : 'บันทึกเวลาแล้ว แต่ต้องตรวจสอบ ⚠'}
          </p>
          {result.status !== 'pass' && <p>{say(reasons, result.reason)}</p>}
          <p className="meta">
            เวลา {when(result.created_at)}
            {two(result.similarity) && ` · ความเหมือน ${two(result.similarity)}`}
            {two(result.live) && ` · หน้าสด ${two(result.live)}`}
          </p>
        </section>
      )}
      <section>
        <h2>ประวัติเช็คอิน 20 ครั้งล่าสุด</h2>
        {history.length === 0 ? (
          <p className="meta">ยังไม่มีประวัติ</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>เวลา</th>
                <th>ผล</th>
                <th>ความเหมือน</th>
                <th>หน้าสด</th>
              </tr>
            </thead>
            <tbody>
              {history.map(row => (
                <tr key={row.id}>
                  <td>{when(row.created_at)}</td>
                  <td>{row.status === 'pass' ? 'ผ่าน ✓' : `⚠ ${say(reasons, row.reason) || 'ต้องตรวจสอบ'}`}</td>
                  <td>{two(row.similarity) ?? '–'}</td>
                  <td>{two(row.live) ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}

function Camera({ onShot, onCancel }: { onShot: (photo: Blob | null) => void; onCancel: () => void }) {
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

  function shoot() {
    const v = video.current
    if (!v?.videoWidth) return
    setReady(false)
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 1280 / v.videoWidth)
    canvas.width = Math.round(v.videoWidth * scale)
    canvas.height = Math.round(v.videoHeight * scale)
    canvas.getContext('2d')?.drawImage(v, 0, 0, canvas.width, canvas.height)
    stop()
    canvas.toBlob(onShot, 'image/jpeg', 0.9)
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

createRoot(document.getElementById('root')!).render(<App />)
