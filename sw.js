'use strict';
// 앱 파일을 폰에 저장해 두어 인터넷이 없어도 열리게 한다. 구글 같은 다른 주소의 요청은 건드리지 않는다.
// 앱 파일을 고쳤으면 아래 CACHE 이름의 숫자를 올려야 폰이 새 파일을 받는다.
const CACHE = 'suyoung-shell-v9';
const FILES = ['index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('notificationclick', (e) => { // 알림을 누르면 앱을 앞으로 가져온다
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((l) => (l.length ? l[0].focus() : self.clients.openWindow('./index.html'))));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => {
    const net = fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy))); }
      return res;
    }).catch(() => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined));
    return hit || net;
  }));
});
