import type { Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Guided, type Pose } from './camera'
import { supabase, url } from './supabase'

type Checkin = { id: number; created_at: string; status: string; reason: string | null; similarity: number | null; live: number | null; frames?: { pose: string; turn: number | null }[] | null }
type Query = Record<string, string>

const errors: Record<string, string> = {
  no_face: 'ไม่พบใบหน้า ลองใหม่ในที่สว่าง หน้าตรง',
  spoof: 'ดูเหมือนรูปถ่ายหรือหน้าจอ ลองถ่ายใหม่',
  challenge: 'หันหน้าไม่ตรงตามคำสั่ง หรือหันน้อยไป ลองใหม่',
  mismatch: 'ภาพแต่ละท่าไม่ใช่คนเดียวกัน ลองใหม่',
  bad_image: 'อ่านรูปไม่ได้ ลองใหม่',
  bad_frames: 'ส่งภาพไม่ครบ ลองใหม่',
  not_enrolled: 'ยังไม่ได้ลงทะเบียนใบหน้า',
  challenge_expired: 'หมดเวลา กดเช็คอินใหม่',
  too_large: 'ภาพใหญ่เกินไป ลองใหม่',
  unauthorized: 'เซสชันหมดอายุ ออกจากระบบแล้วเข้าใหม่',
}

const reasons: Record<string, string> = {
  no_face: 'ไม่พบใบหน้า',
  spoof: 'อาจเป็นรูปถ่าย/หน้าจอ',
  challenge: 'ไม่ได้หันตามคำสั่ง',
  mismatch: 'หน้าไม่ตรงกับที่ลงทะเบียน',
}

const sides: Record<string, string> = { left: 'ซ้าย', right: 'ขวา' }

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
      <p className="meta">
        <a href="./human.html">ลองแบบ Human</a>
      </p>
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
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 6) {
      setMsg('กรอกอีเมล และรหัสผ่านอย่างน้อย 6 ตัวในช่องด้านบนก่อน แล้วค่อยกดปุ่ม')
      return
    }
    setBusy(true)
    setMsg('')
    const { data, error } = signUp ? await supabase.auth.signUp({ email, password }) : await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) setMsg(say(authErrors, error.code) || `ไม่สำเร็จ: ${error.message}`)
    else if (!data.session) setMsg('ส่งอีเมลยืนยันแล้ว กดลิงก์ในอีเมล แล้วกลับมาเข้าสู่ระบบ')
  }

  return (
    <form
      noValidate
      onSubmit={e => {
        e.preventDefault()
        go(false)
      }}
    >
      <p className="meta">ครั้งแรก: กรอกอีเมลและตั้งรหัสผ่าน 6 ตัวขึ้นไป แล้วกด “สมัครสมาชิก” เข้าระบบได้ทันที ไม่ต้องยืนยันอีเมล</p>
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
        <button type="button" disabled={busy} onClick={() => go(true)}>
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
  const [camera, setCamera] = useState<{ steps: Pose[]; query: Query } | null>(null)
  const [locked, setLocked] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Checkin | null>(null)
  const [msg, setMsg] = useState('')
  const turned = result?.frames
    ?.filter(frame => say(sides, frame.pose))
    .map(frame => `${say(sides, frame.pose)} ${two(frame.turn) ?? '–'}`)
    .join(' · ')

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
    setResult(null)
    setMsg('')
  }

  async function post(query: Query, form?: FormData) {
    const { data } = await supabase.auth.getSession()
    const res = await fetch(`${url}/functions/v1/face-checkin?${new URLSearchParams(query)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${data.session?.access_token}` },
      body: form,
      signal: AbortSignal.timeout(form ? 30_000 : 20_000),
    })
    const body = await res.json()
    if (res.status === 423) setLocked(true)
    else if (!res.ok) setMsg(say(errors, body?.error) || 'ระบบขัดข้อง ลองใหม่ภายหลัง')
    if (res.status === 409) await load()
    return res.ok ? body : null
  }

  async function checkin() {
    begin()
    setBusy(true)
    try {
      const body = await post({ action: 'challenge' })
      if (body) setCamera({ steps: ['front', ...body.steps], query: { action: 'checkin', challenge: body.id } })
    } catch {
      setMsg('เชื่อมต่อไม่ได้หรือรอนานเกินไป ลองใหม่อีกครั้ง')
    } finally {
      setBusy(false)
    }
  }

  async function submit(query: Query, frames: Blob[] | null) {
    setCamera(null)
    if (!frames || frames.reduce((total, frame) => total + frame.size, 0) >= 3_000_000) {
      setMsg(errors[frames ? 'too_large' : 'bad_image'])
      return
    }
    const form = new FormData()
    frames.forEach((frame, i) => form.append('frame', frame, `frame-${i}.jpg`))
    setBusy(true)
    try {
      const body = await post(query, form)
      if (!body) return
      if (query.action === 'checkin') setResult(body)
      else {
        setAgain(false)
        setConsent(false)
        setMsg('ลงทะเบียนใบหน้าแล้ว')
      }
      await load()
    } catch {
      setMsg(query.action === 'checkin' ? 'ไม่แน่ใจว่าบันทึกเวลาแล้วหรือยัง ดูประวัติด้านล่างก่อนลองใหม่' : 'เชื่อมต่อไม่ได้หรือรอนานเกินไป ลองใหม่อีกครั้ง')
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function unlock() {
    begin()
    setBusy(true)
    const { error } = await supabase.auth.signInWithPassword({ email: session.user.email!, password })
    setBusy(false)
    if (error) setMsg(say(authErrors, error.code) || 'รหัสผ่านไม่ถูกต้อง')
    else {
      setLocked(false)
      setPassword('')
      setMsg('ปลดล็อกแล้ว กดเช็คอินอีกครั้ง')
    }
  }

  async function forget() {
    if (!window.confirm('ลบข้อมูลใบหน้า? ต้องลงทะเบียนใหม่ก่อนเช็คอินครั้งต่อไป')) return
    begin()
    setBusy(true)
    const { error } = await supabase.from('face_enrollments').delete().eq('user_id', session.user.id)
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
        <Guided steps={camera.steps} onDone={frames => submit(camera.query, frames)} onCancel={() => setCamera(null)} />
      ) : (
        <>
          {locked ? (
            <form
              noValidate
              onSubmit={e => {
                e.preventDefault()
                unlock()
              }}
            >
              <h2>ล็อกการสแกนหน้าไว้ก่อน</h2>
              <p>เช็คอินครั้งก่อนระบบสงสัยว่าเป็นรูป หน้าจอ หรือคนอื่น ใส่รหัสผ่านอีกครั้งเพื่อปลดล็อก เหมือน iPhone ที่ให้ใส่รหัสหลังสแกนหน้าไม่ผ่าน</p>
              <label>
                รหัสผ่าน
                <input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
              </label>
              <div className="row">
                <button className="primary" disabled={busy}>
                  ปลดล็อก
                </button>
                {enrolledAt && (
                  <button type="button" disabled={busy} onClick={forget}>
                    ลบข้อมูลใบหน้า
                  </button>
                )}
              </div>
            </form>
          ) : (
            enrolledAt && (
              <section>
                <p>ลงทะเบียนเมื่อ {when(enrolledAt)}</p>
                <div className="row">
                  <button className="primary" disabled={busy} onClick={checkin}>
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
            )
          )}
          {(enrolledAt === null || again) && (
            <section>
              <h2>ขอความยินยอมใช้ข้อมูลใบหน้า</h2>
              <ul>
                <li>ระบบจะให้หันหน้า 5 ท่า แล้วแปลงแต่ละท่าเป็นตัวเลข 128 ค่าเก็บไว้เทียบตอนเช็คอิน ไม่เก็บรูป</li>
                <li>ข้อมูลใบหน้าเป็นข้อมูลชีวภาพตาม PDPA ม.26 จึงต้องขอความยินยอม</li>
                <li>ลบได้ทุกเมื่อด้วยปุ่ม “ลบข้อมูลใบหน้า”</li>
              </ul>
              <label className="check">
                <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
                ยินยอมให้ใช้ข้อมูลใบหน้าเพื่อเช็คอิน
              </label>
              <button
                className="primary"
                disabled={!consent || busy || locked}
                onClick={() => {
                  begin()
                  setCamera({ steps: ['front', 'left', 'right', 'up', 'down'], query: { action: 'enroll' } })
                }}
              >
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
          {result.status !== 'pass' && ['spoof', 'challenge', 'mismatch'].includes(result.reason ?? '') && <p>ครั้งต่อไปต้องใส่รหัสผ่านก่อนสแกน</p>}
          <p className="meta">
            เวลา {when(result.created_at)}
            {two(result.similarity) && ` · ความเหมือน ${two(result.similarity)}`}
            {two(result.live) && ` · หน้าสด ${two(result.live)}`}
            {turned && ` · หัน ${turned}`}
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

createRoot(document.getElementById('root')!).render(<App />)
