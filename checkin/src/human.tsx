import type { Session } from '@supabase/supabase-js'
import { Human } from '@vladmandic/human'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Camera } from './camera'
import { supabase } from './supabase'

type Action = 'register' | 'checkin'
type Face = { name: string; created_at: string }
type Row = { id: number; name: string; similarity: number | null; real_score: number | null; created_at: string }
type Scan = { matched?: boolean; name?: string | null; similarity?: number | null; checked_in_at?: string | null; real?: number; live?: number }

const minReal = 0.5

const human = new Human({
  modelBasePath: './models/',
  cacheSensitivity: 0,
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false },
  segmentation: { enabled: false },
  face: {
    detector: { maxDetected: 1 },
    mesh: { enabled: false },
    iris: { enabled: false },
    emotion: { enabled: false },
    description: { enabled: true },
    antispoof: { enabled: true },
    liveness: { enabled: true },
  },
})

const when = (iso: string) => new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' })
const two = (n: unknown) => (typeof n === 'number' ? n.toFixed(2) : null)

async function detect(photo: Blob) {
  const bitmap = await createImageBitmap(photo)
  const result = await human.detect(bitmap)
  bitmap.close()
  return result.face[0]
}

function App() {
  const [session, setSession] = useState<Session | null>()
  const [models, setModels] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    human
      .load()
      .then(() => {
        if (human.models.stats().modelStats.some(model => !model.loaded)) throw new Error('model')
        return human.warmup()
      })
      .then(
        () => setModels('ready'),
        () => setModels('error'),
      )
    return () => data.subscription.unsubscribe()
  }, [])

  return (
    <>
      <h1>Face Check-in แบบ Human (ทดสอบ)</h1>
      <p className="meta">แปลงใบหน้าเป็นตัวเลขในเบราว์เซอร์ แล้วค้นหาจากทุกคนด้วย pgvector (ตามแผนของพล)</p>
      <p className="meta">
        <a href="./">กลับหน้าหลัก</a>
      </p>
      {models !== 'ready' && (
        <p className="msg" role="status">
          {models === 'error' ? 'โหลดโมเดลไม่สำเร็จ ตรวจอินเทอร์เน็ตแล้วรีเฟรชหน้า' : 'กำลังโหลดโมเดล…'}
        </p>
      )}
      {session === null && (
        <p>
          <a href="./">เข้าสู่ระบบที่หน้าหลักก่อน</a>
        </p>
      )}
      {session && <Home key={session.user.id} session={session} ready={models === 'ready'} />}
    </>
  )
}

function Home({ session, ready }: { session: Session; ready: boolean }) {
  const [face, setFace] = useState<Face | null>()
  const [history, setHistory] = useState<Row[]>([])
  const [again, setAgain] = useState(false)
  const [consent, setConsent] = useState(false)
  const [name, setName] = useState('')
  const [camera, setCamera] = useState<Action | null>(null)
  const [busy, setBusy] = useState(false)
  const [scan, setScan] = useState<Scan | null>(null)
  const [msg, setMsg] = useState('')
  const off = busy || !ready

  async function load() {
    const [own, rows] = await Promise.all([
      supabase.from('users_faces').select('name, created_at').eq('user_id', session.user.id).maybeSingle(),
      supabase.from('face_attendance').select('id, name, similarity, real_score, created_at').order('created_at', { ascending: false }).limit(20),
    ])
    if (own.error || rows.error) {
      setMsg('โหลดข้อมูลไม่ได้ ลองรีเฟรชหน้า')
      return
    }
    setFace(own.data)
    setHistory(rows.data)
  }

  useEffect(() => {
    load()
  }, [])

  function begin() {
    setScan(null)
    setMsg('')
  }

  function open(action: Action) {
    begin()
    setCamera(action)
  }

  async function shot(action: Action, photo: Blob | null) {
    setCamera(null)
    setBusy(true)
    try {
      const found = photo ? await detect(photo) : undefined
      const real = found?.real ?? 0
      if (!found?.embedding?.length) {
        setMsg(action === 'checkin' ? 'ไม่พบใบหน้า' : 'ไม่พบใบหน้า ลองใหม่')
        return
      }
      if (action === 'checkin') setScan({ real, live: found.live })
      if (!(real >= minReal)) {
        setMsg(action === 'checkin' ? 'ดูเหมือนรูปถ่ายหรือหน้าจอ ไม่ได้บันทึก' : 'ดูเหมือนรูปถ่ายหรือหน้าจอ ลองใหม่')
        return
      }
      if (action === 'checkin') {
        const { data, error } = await supabase.rpc('match_face', { query: found.embedding, real_score: real }).abortSignal(AbortSignal.timeout(20_000))
        if (error) setMsg('ระบบขัดข้อง ดูประวัติด้านล่างก่อนลองใหม่')
        else setScan({ ...data?.[0], real, live: found.live })
        await load()
        return
      }
      const { error } = await supabase.rpc('register_face', { name: name.trim(), embedding: found.embedding }).abortSignal(AbortSignal.timeout(20_000))
      if (error) {
        setMsg('ลงทะเบียนไม่สำเร็จ ลองใหม่')
        return
      }
      setAgain(false)
      setConsent(false)
      setMsg('ลงทะเบียนแล้ว')
      await load()
    } catch {
      setMsg('ตรวจใบหน้าไม่สำเร็จ ลองใหม่')
    } finally {
      setBusy(false)
    }
  }

  async function forget() {
    if (!window.confirm('ลบข้อมูลใบหน้า? ต้องลงทะเบียนใหม่ก่อนจะเช็คอินด้วยหน้านี้ได้')) return
    begin()
    setBusy(true)
    const { error } = await supabase.from('users_faces').delete().eq('user_id', session.user.id)
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
        <Camera onShot={photo => shot(camera, photo)} onCancel={() => setCamera(null)} />
      ) : (
        <>
          <section>
            <button className="primary" disabled={off} onClick={() => open('checkin')}>
              สแกนเช็คอิน
            </button>
          </section>
          {face && (
            <section>
              <p>
                ลงทะเบียนเป็น “{face.name}” เมื่อ {when(face.created_at)}
              </p>
              <div className="row">
                <button
                  disabled={off}
                  onClick={() => {
                    begin()
                    setAgain(true)
                    setConsent(false)
                    setName(face.name)
                  }}
                >
                  ลงทะเบียนใหม่
                </button>
                <button disabled={off} onClick={forget}>
                  ลบข้อมูลใบหน้า
                </button>
              </div>
            </section>
          )}
          {(face === null || again) && (
            <section>
              <h2>ขอความยินยอมใช้ข้อมูลใบหน้า</h2>
              <ul>
                <li>ระบบจะแปลงใบหน้าเป็นตัวเลข 1024 ค่าในเครื่องนี้ ส่งเฉพาะตัวเลขไปเก็บพร้อมชื่อ ไม่เก็บรูป</li>
                <li>ข้อมูลใบหน้าเป็นข้อมูลชีวภาพตาม PDPA ม.26 จึงต้องขอความยินยอม</li>
                <li>ลบได้ทุกเมื่อด้วยปุ่ม “ลบข้อมูลใบหน้า”</li>
              </ul>
              <label className="check">
                <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
                ยินยอมให้ใช้ข้อมูลใบหน้าเพื่อเช็คอิน
              </label>
              <label>
                ชื่อ
                <input type="text" autoComplete="name" maxLength={80} value={name} onChange={e => setName(e.target.value)} />
              </label>
              <button className="primary" disabled={!consent || !name.trim() || off} onClick={() => open('register')}>
                ลงทะเบียนใบหน้า
              </button>
            </section>
          )}
        </>
      )}
      <p className="msg" role="status">
        {busy ? 'กำลังตรวจ…' : msg || (face === undefined ? 'กำลังโหลด…' : '')}
      </p>
      {scan && (
        <section>
          {scan.matched !== undefined && (
            <p className={scan.matched ? 'verdict ok' : 'verdict warn'}>{scan.matched ? <>เช็คอินแล้ว: {scan.name} ✓</> : 'ไม่พบคนที่ตรงกัน ⚠'}</p>
          )}
          <p className="meta">
            {scan.checked_in_at && `เวลา ${when(scan.checked_in_at)} · `}
            ความเหมือน {two(scan.similarity) ?? '–'} · ของจริง {two(scan.real) ?? '–'} · หน้าสด {two(scan.live) ?? '–'}
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
                <th>ชื่อ</th>
                <th>ความเหมือน</th>
                <th>ของจริง</th>
              </tr>
            </thead>
            <tbody>
              {history.map(row => (
                <tr key={row.id}>
                  <td>{when(row.created_at)}</td>
                  <td>{row.name}</td>
                  <td>{two(row.similarity) ?? '–'}</td>
                  <td>{two(row.real_score) ?? '–'}</td>
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
