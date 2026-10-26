'use strict';
// 앱 파일을 폰에 저장해 두어 인터넷이 없어도 열리게 한다. 구글 같은 다른 주소의 요청은 건드리지 않는다.
// 앱 파일을 고쳤으면 아래 CACHE 이름의 숫자를 올려야 폰이 새 파일을 받는다.
const CACHE = 'suyoung-shell-v40';
const OCR_CACHE = 'suyoung-ocr-v1'; // 글자 읽기 파일(약 14MB)은 쓸 때 한 번만 받아 두고, 앱 버전이 바뀌어도 지우지 않는다. 파일을 바꾸면 이름의 숫자를 올린다
const FILES = ['index.html', 'style.css', 'app.js', 'report.js', 'capture.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icons/a1/bld.svg', 'icons/a1/home.svg', 'icons/a1/cone.svg', 'icons/a1/ruler.svg', 'icons/a1/search.svg', 'icons/a1/cam.svg', 'icons/a1/users.svg', 'icons/a1/hand.svg', 'icons/a1/brief.svg', 'icons/a1/cal.svg', 'icons/a1/tel.svg', 'icons/a1/chat.svg', 'icons/a1/note.svg', 'icons/a1/clip.svg', 'icons/a1/fold.svg', 'icons/a1/rec.svg', 'icons/a1/chart.svg', 'icons/a1/ok.svg', 'icons/a1/pin.svg', 'icons/a1/wrench.svg', 'icons/a2/bld.svg', 'icons/a2/home.svg', 'icons/a2/cone.svg', 'icons/a2/ruler.svg', 'icons/a2/search.svg', 'icons/a2/cam.svg', 'icons/a2/users.svg', 'icons/a2/hand.svg', 'icons/a2/brief.svg', 'icons/a2/cal.svg', 'icons/a2/tel.svg', 'icons/a2/chat.svg', 'icons/a2/note.svg', 'icons/a2/clip.svg', 'icons/a2/fold.svg', 'icons/a2/rec.svg', 'icons/a2/chart.svg', 'icons/a2/ok.svg', 'icons/a2/pin.svg', 'icons/a2/wrench.svg', 'icons/a3/bld.svg', 'icons/a3/home.svg', 'icons/a3/ruler.svg', 'icons/a3/search.svg', 'icons/a3/cam.svg', 'icons/a3/users.svg', 'icons/a3/brief.svg', 'icons/a3/cal.svg', 'icons/a3/tel.svg', 'icons/a3/chat.svg', 'icons/a3/note.svg', 'icons/a3/clip.svg', 'icons/a3/fold.svg', 'icons/a3/rec.svg', 'icons/a3/chart.svg', 'icons/a3/ok.svg', 'icons/a3/pin.svg', 'icons/a3/wrench.svg', 'icons/a3/cone.svg', 'icons/a3/hand.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== OCR_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('notificationclick', (e) => { // 알림을 누르면 앱을 앞으로 가져온다
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((l) => (l.length ? l[0].focus() : self.clients.openWindow('./index.html'))));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (new URL(req.url).pathname.includes('/ocr/')) { // 글자 읽기 파일: 저장해 둔 것을 먼저 쓰고, 없으면 받아서 저장
    e.respondWith(caches.open(OCR_CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => { if (res && res.ok) c.put(req, res.clone()); return res; }))));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => {
    const net = fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy))); }
      return res;
    }).catch(() => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined));
    return hit || net;
  }));
});
