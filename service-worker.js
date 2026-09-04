/* service-worker.js - オフライン動作用のキャッシュ
   リリースごとに CACHE_NAME を上げること (Claude verXX と対応させる) */
var CACHE_NAME = 'meallog-v5';   /* Claude ver05 */
var ASSETS = [
  './',
  'index.html',
  'css/style.css?v=20260905-05',
  'js/store.js?v=20260905-05',
  'js/foods.js?v=20260905-05',
  'js/nutrition.js?v=20260905-05',
  'js/barcode.js?v=20260905-05',
  'js/ui-meal.js?v=20260905-05',
  'js/ui-body.js?v=20260905-05',
  'js/ui-graph.js?v=20260905-05',
  'js/ui-advice.js?v=20260905-05',
  'js/ui-settings.js?v=20260905-05',
  'js/app.js?v=20260905-05',
  'vendor/zxing.min.js',
  'data/foods.json',
  'data/common.json',
  'data/kanji-yomi.json',
  'data/product-nutrients.json',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', function (ev) {
  ev.waitUntil(
    caches.open(CACHE_NAME).then(function (c) {
      // 1件でも失敗すると install ごと失敗するため個別に addAll しない
      return Promise.all(ASSETS.map(function (u) {
        return c.add(u).catch(function (e) { void e; });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return (k === CACHE_NAME) ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // 外部API(商品情報の検索)はキャッシュせずネットワークのみ
  if (url.origin !== self.location.origin) return;

  ev.respondWith(
    caches.match(req, { ignoreSearch: false }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        // オフラインでナビゲーション要求ならシェルを返す
        if (req.mode === 'navigate') return caches.match('index.html');
        return caches.match(req, { ignoreSearch: true });
      });
    })
  );
});
