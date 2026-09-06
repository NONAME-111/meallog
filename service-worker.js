/* service-worker.js - オフライン動作用のキャッシュ
   リリースごとに CACHE_NAME を上げること (画面の全体バージョンと対応させる) */
var CACHE_NAME = 'meallog-v11';   /* v11 / Codex v4 */
var ASSETS = [
  './',
  'index.html',
  'css/style.css?v=20260906-11',
  'js/store.js?v=20260906-11',
  'js/foods.js?v=20260906-11',
  'js/estimate.js?v=20260906-11',
  'js/nutrition.js?v=20260906-11',
  'js/nutrition-label.js?v=20260906-11',
  'js/barcode.js?v=20260906-11',
  'js/ui-meal.js?v=20260906-11',
  'js/steps.js?v=20260906-11',
  'js/ui-body.js?v=20260906-11',
  'js/ui-graph.js?v=20260906-11',
  'js/ui-advice.js?v=20260906-11',
  'js/ui-settings.js?v=20260906-11',
  'js/app.js?v=20260906-11',
  'vendor/zxing.min.js',
  'data/foods.json',
  'data/common.json',
  'data/kanji-yomi.json',
  'data/product-nutrients.json',
  'data/food-categories.json',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512-maskable.png',
  'icons/favicon-64.png',
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
