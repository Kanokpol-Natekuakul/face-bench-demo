import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const html = readFileSync(new URL('./site/index.html', import.meta.url), 'utf8')
const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]

function page() {
  const elements = new Map()
  const store = new Map()
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { hidden: false, value: '', textContent: '', handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler }, setAttribute() {}, focus() { this.focused = true } })
    return elements.get(id)
  } }
  const context = vm.createContext({ document, localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) }, location: { hash: '', pathname: '/' }, history: { replaceState() {} }, URLSearchParams, performance, Blob, URL, AbortController, AbortSignal, DOMException, setTimeout, clearTimeout, setInterval, clearInterval })
  vm.runInContext(source + '\nglobalThis.api = { scan, failText }', context)
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
