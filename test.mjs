import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const html = readFileSync(new URL('./site/index.html', import.meta.url), 'utf8')
const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]

function page(initial = {}) {
  const elements = new Map()
  const store = new Map(Object.entries(initial))
  const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map(([tag]) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value])))
  const document = { getElementById(id) {
    if (!elements.has(id)) {
      const attrs = inputs.find(input => input.id === id) || {}
      elements.set(id, {
        ...attrs, hidden: false, value: attrs.value || '', defaultValue: attrs.value || '', textContent: '', handlers: {},
        addEventListener(event, handler) { this.handlers[event] = handler }, setAttribute() {}, focus() { this.focused = true },
        checkValidity() {
          if (id === 'settingsForm') return inputs.filter(input => input.type === 'number').every(input => document.getElementById(input.id).checkValidity())
          if (attrs.type !== 'number') return true
          const value = Number(this.value)
          const steps = (value - Number(attrs.min || 0)) / Number(attrs.step || 1)
          return String(this.value).trim() !== '' && Number.isFinite(value) && value >= Number(attrs.min) && value <= Number(attrs.max) && Math.abs(steps - Math.round(steps)) < 1e-7
        },
        reportValidity() { return this.checkValidity() },
      })
    }
    return elements.get(id)
  } }
  const context = vm.createContext({ document, localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) }, location: { hash: '', pathname: '/', reload() {} }, history: { replaceState() {} }, URLSearchParams, performance, Blob, URL, AbortController, AbortSignal, DOMException, setTimeout, clearTimeout, setInterval, clearInterval })
  vm.runInContext(source + '\nglobalThis.api = { scan, failText, toJpeg }', context)
  return { context, store, element: document.getElementById, ...context.api }
}

test('missing key stops enrollment before preparing or uploading a photo', async () => {
  const p = page()
  p.context.fetch = () => { throw new Error('photo must not be uploaded') }
  p.context.createImageBitmap = () => { throw new Error('photo must not be decoded') }
  await assert.rejects(p.scan(new Blob(), p.element('enrollStatus')), /กรอก key|เปิด.*QR/)
  assert.equal(p.element('keybox').hidden, false)
  assert.equal(p.element('key').focused, true)
})

test('a stalled upload aborts and explains the timeout', async () => {
  const p = page()
  p.store.set('fb-key', 'test-key')
  vm.runInContext('toJpeg = async () => new Blob(["jpeg"], { type: "image/jpeg" })', p.context)
  let deadline
  p.context.AbortSignal = { timeout(ms) {
    deadline = ms
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), 5)
    return controller.signal
  } }
  p.context.fetch = async (_, options) => {
    assert.ok(options.signal, 'uploads need a deadline')
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  }
  await assert.rejects(p.scan(new Blob(), p.element('enrollStatus')), error => {
    assert.equal(error.name, 'TimeoutError')
    assert.match(p.failText(error), /20 วินาที/)
    return true
  })
  assert.equal(deadline, 20_000)
})

test('a rejected key exposes the key field so the user can correct it', async () => {
  const p = page()
  p.store.set('fb-key', 'old-key')
  p.element('keybox').hidden = true
  vm.runInContext('toJpeg = async () => new Blob(["jpeg"])', p.context)
  p.context.fetch = async () => ({ status: 403, ok: false, json: async () => ({ error: 'forbidden' }) })
  await assert.rejects(p.scan(new Blob(), p.element('enrollStatus')), /key ไม่ถูกต้อง/)
  assert.equal(p.element('keybox').hidden, false)
  assert.equal(p.element('key').focused, true)
})

test('a manually entered key is used without waiting for a change event', async () => {
  const p = page()
  p.element('key').value = '  test-key  '
  vm.runInContext('toJpeg = async () => new Blob(["jpeg"], { type: "image/jpeg" })', p.context)
  p.context.fetch = async (_, options) => {
    assert.equal(options.headers['x-bench-key'], 'test-key')
    assert.ok(options.signal)
    return { status: 200, ok: true, json: async () => ({ embedding: [1, 0], ms: { total: 1 } }) }
  }
  const result = await p.scan(new Blob(), p.element('enrollStatus'))
  assert.deepEqual(result.embedding, [1, 0])
  assert.equal(p.element('enrollStatus').textContent, '')
  URL.revokeObjectURL(result.url)
})

test('a matching face fails check-in when it is not a live capture', async () => {
  const p = page()
  p.store.set('fb-enroll', JSON.stringify({ embedding: [1, 0] }))
  const verdict = async (real) => {
    vm.runInContext(`scan = async () => ({ embedding: [1, 0], real: ${real}, ms: { total: 1, decode: 0, detect: 0, embed: 0, spoof: 0 }, mem: { heap: 0, external: 0 }, roundTrip: 1, kb: 1, url: '' })`, p.context)
    await p.element('checkInput').handlers.change({ target: { files: [new Blob()], value: '' } })
    return p.element('verdict').textContent
  }
  assert.match(await verdict(0.1), /ไม่ใช่หน้าสด/)
  assert.match(await verdict(0.9), /คนเดียวกัน ✓/)
})

test('threshold settings re-evaluate the latest scores without another scan', async () => {
  const p = page()
  p.store.set('fb-enroll', JSON.stringify({ embedding: [1, 0] }))
  vm.runInContext(`globalThis.scans = 0; scan = async () => {
    scans++
    return { embedding: [0.8, 0.6], real: 0.52, ms: { total: 1, decode: 0, detect: 0, embed: 0, spoof: 0 }, mem: { heap: 0, external: 0 }, roundTrip: 1, kb: 1, url: '' }
  }`, p.context)
  await p.element('checkInput').handlers.change({ target: { files: [new Blob()], value: '' } })
  assert.match(p.element('verdict').textContent, /คนเดียวกัน ✓/)
  assert.equal(typeof p.element('liveThreshold').handlers.input, 'function', 'the liveness setting must be editable')
  const change = (id, value) => {
    p.element(id).value = String(value)
    p.element(id).handlers.input()
  }
  change('liveThreshold', 0.6)
  assert.match(p.element('verdict').textContent, /ไม่ใช่หน้าสด/)
  assert.match(p.element('checkMeta').innerHTML, /0.52.*0.6/)
  change('liveThreshold', 0.52)
  assert.match(p.element('verdict').textContent, /คนเดียวกัน ✓/)
  change('matchThreshold', 0.85)
  assert.match(p.element('verdict').textContent, /ไม่ใช่คนเดียวกัน/)
  change('matchThreshold', 0.8)
  assert.match(p.element('verdict').textContent, /คนเดียวกัน ✓/)
  assert.match(p.element('checkMeta').innerHTML, /0.800/)
  assert.equal(p.context.scans, 1)
})

test('settings survive reload and reset without deleting the enrollment or key', () => {
  const p = page({ 'fb-key': 'test-key', 'fb-enroll': JSON.stringify({ embedding: [1, 0], thumb: '', info: '' }) })
  const chosen = { liveThreshold: 0.6, matchThreshold: 0.7, maxWidth: 800, jpegQuality: 0.8, maxKB: 100 }
  for (const [id, value] of Object.entries(chosen)) {
    p.element(id).value = String(value)
    p.element(id).handlers.input()
  }
  assert.deepEqual(JSON.parse(p.store.get('fb-settings') || 'null'), chosen)
  const reloaded = page(Object.fromEntries(p.store))
  for (const [id, value] of Object.entries(chosen)) assert.equal(Number(reloaded.element(id).value), value)
  reloaded.element('resetSettings').handlers.click()
  assert.deepEqual(JSON.parse(reloaded.store.get('fb-settings')), { liveThreshold: 0.5, matchThreshold: 0.363, maxWidth: 1920, jpegQuality: 0.9, maxKB: 300 })
  assert.equal(reloaded.store.get('fb-key'), 'test-key')
  assert.ok(reloaded.store.get('fb-enroll'))
  reloaded.element('reset').handlers.click()
  assert.equal(reloaded.store.size, 0)
})

test('stored settings validate ranges, steps and types while allowing zero', () => {
  const p = page({ 'fb-settings': JSON.stringify({ liveThreshold: 0, matchThreshold: -1, maxWidth: 320, jpegQuality: 0.4, maxKB: 50 }) })
  assert.equal(Number(p.element('liveThreshold').value), 0)
  assert.equal(Number(p.element('matchThreshold').value), -1)
  for (const raw of ['{', 'null', '[1,2]', JSON.stringify({ liveThreshold: 2, matchThreshold: '0', maxWidth: 319, jpegQuality: 0.91, maxKB: 1001 })]) {
    const invalid = page({ 'fb-settings': raw })
    for (const id of ['liveThreshold', 'matchThreshold', 'maxWidth', 'jpegQuality', 'maxKB']) {
      assert.equal(Number(invalid.element(id).value), Number(invalid.element(id).defaultValue))
    }
  }
})

test('invalid settings stop uploads before decoding and do not overwrite saved values', async () => {
  const p = page({ 'fb-key': 'test-key' })
  p.element('liveThreshold').value = '0.6'
  p.element('liveThreshold').handlers.input()
  const saved = p.store.get('fb-settings')
  p.context.createImageBitmap = () => { throw new Error('invalid settings must not decode a photo') }
  p.context.fetch = () => { throw new Error('invalid settings must not upload a photo') }
  for (const [id, value] of [['liveThreshold', ''], ['liveThreshold', '1.1'], ['liveThreshold', '0.601'], ['jpegQuality', 'NaN'], ['maxKB', '49']]) {
    p.element(id).value = value
    p.element(id).handlers.input()
    assert.match(p.element('settingsStatus').textContent, /ไม่ถูกต้อง/)
    await assert.rejects(p.scan(new Blob(), p.element('enrollStatus')), /ค่าตั้งค่า/)
    if (id === 'maxKB') assert.equal(p.element('imageOptions').open, true, 'invalid advanced controls must be revealed before browser validation focuses them')
    assert.equal(p.store.get('fb-settings'), saved)
    p.element(id).value = p.element(id).defaultValue
  }
})

test('image settings control resizing, initial JPEG quality and the byte limit', async () => {
  const p = page()
  for (const [id, value] of Object.entries({ maxWidth: 800, jpegQuality: 0.8, maxKB: 50 })) {
    p.element(id).value = String(value)
    p.element(id).handlers.input()
  }
  const qualities = []
  const canvas = {
    getContext: () => ({ drawImage() {} }),
    toBlob(resolve, type, quality) {
      assert.equal(type, 'image/jpeg')
      qualities.push(quality)
      resolve(new Blob([new Uint8Array((quality > 0.4 ? 400 : 40) * 1024)]))
    },
  }
  p.context.createImageBitmap = async () => ({ width: 4000, height: 3000, close() {} })
  p.context.document.createElement = () => canvas
  const jpeg = await p.toJpeg(new Blob())
  assert.equal(canvas.width, 800)
  assert.equal(canvas.height, Math.round(3000 * 800 / 4000))
  assert.equal(qualities[0], 0.8)
  assert.equal(qualities.at(-1), 0.4)
  assert.ok(qualities.every(quality => quality >= 0.4))
  assert.ok(jpeg.size <= 50 * 1024)
})

test('unencodable or oversized images never upload and explain how to recover', async () => {
  const p = page({ 'fb-key': 'test-key' })
  p.element('maxKB').value = '50'
  p.element('maxKB').handlers.input()
  p.context.createImageBitmap = async () => ({ width: 1000, height: 1000, close() {} })
  const canvas = { getContext: () => ({ drawImage() {} }), toBlob: resolve => resolve(new Blob([new Uint8Array(400 * 1024)])) }
  p.context.document.createElement = () => canvas
  p.context.fetch = () => { throw new Error('an invalid JPEG must not upload') }
  await assert.rejects(p.scan(new Blob(), p.element('enrollStatus')), /เกิน 50 KB.*ลดความกว้าง|เพิ่ม.*ขนาด/)
  canvas.toBlob = resolve => resolve(null)
  await assert.rejects(p.scan(new Blob(), p.element('enrollStatus')), /แปลงรูป.*JPEG.*ไม่ได้/)
})
