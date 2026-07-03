// 極簡 service worker：讓 PWA 可安裝；API 請求一律走網路
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());
self.addEventListener('fetch', e => {
  if (e.request.url.includes('googleapis.com')) return; // API 不快取
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
