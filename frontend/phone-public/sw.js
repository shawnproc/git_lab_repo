// Keystone Ledger offline cache. Same-origin GET only; nothing personal is ever cached here
// (holdings and the wall live in local storage, not in HTTP responses).
const CACHE = 'keystone-v1'

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './index.html', './snapshot.json', './manifest.webmanifest'])).catch(() => undefined))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return
  const fresh = req.mode === 'navigate' || url.pathname.endsWith('/snapshot.json') || url.pathname.endsWith('/index.html')
  if (fresh) {
    // Network first so data and app updates arrive; cached copy when offline.
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone() // clone before the page reads the body
          caches.open(CACHE).then((c) => c.put(req, copy))
        }
        return res
      }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))),
    )
    return
  }
  // Hashed build assets never change: cache first.
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(req, copy))
      }
      return res
    })),
  )
})
