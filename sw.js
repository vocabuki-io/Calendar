/* Service Worker — PWA用。アプリ本体は「ネットワーク優先」で常に最新を取得し、
 * オフライン時のみキャッシュにフォールバックする。
 * GitHub API へのリクエストはキャッシュせず常にネットワークへ。
 *
 * ネットワーク優先にすることで、デプロイ後に古い画面が表示され続ける問題を防ぐ。 */
const CACHE = 'cal-shell-v2';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
];

self.addEventListener('install', (e) => {
  // 新しい版を即座に有効化（待機しない）
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  // 古いキャッシュを破棄して、すぐに全クライアントを制御下に
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // API・クロスオリジン・非GETはネットワーク直結（キャッシュしない）
  if (url.origin !== self.location.origin || req.method !== 'GET') {
    return;
  }

  // 同一オリジンのアプリ本体: ネットワーク優先（成功時にキャッシュ更新）、
  // 失敗（オフライン）時のみキャッシュにフォールバック。
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});
