/* service-worker.js - オフライン動作用のキャッシュ
   リリースごとに CACHE_NAME を上げること (画面の全体バージョンと対応させる) */
var CACHE_NAME = 'meallog-v50-cl42';   /* v50 / Claude ver42 */
var ASSETS = [
  './',
  'index.html',
  'css/style.css?v=20261025-50',
  'js/store.js?v=20261025-50',
  'js/foods.js?v=20261025-50',
  'js/estimate.js?v=20261025-50',
  'js/nutrition.js?v=20261025-50',
  'js/nutrition-label.js?v=20261025-50',
  'js/barcode.js?v=20261025-50',
  'js/ocr.js?v=20261025-50',
  'js/drum.js?v=20261025-50',
  'js/ui-meal.js?v=20261025-50',
  'js/steps.js?v=20261025-50',
  'js/ui-body.js?v=20261025-50',
  'js/ui-graph.js?v=20261025-50',
  'js/ui-advice.js?v=20261025-50',
  'js/ui-settings.js?v=20261025-50',
  'js/app.js?v=20261025-50',
  'vendor/zxing.min.js',
  'data/foods.json',
  'data/common.json',
  'data/kanji-yomi.json',
  'data/product-nutrients.json',
  'data/food-categories.json',
  'data/menu-items.json',        /* 外食チェーンのメニュー。45KBと小さいので先読みする */
  /* data/off-japan.json は 0.7MB あるので先読みしない。
     バーコードを読んだときに初めて取りに行き、そのとき控えに入る */
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512-maskable.png',
  'icons/favicon-64.png',
  'icons/icon-512.png'
];

/* 栄養成分表示の読み取りの部品(約33MB)は、版ごとの控えとは別にしまう。
   版を上げるたびに消すと、更新のたびに読み込み直しになるため。先読みもしない
   (使うときに初めて取りに行き、ここに残る)。部品を入れ替えるときはフォルダ名に版を入れて
   別の名前にする(vendor/ort-1.23.2/ など)。いま使っていない部品は activate で消す */
var OCR_CACHE = 'meallog-ocr';
var OCR_FILES = [
  'vendor/ort-1.23.2/ort.wasm.min.js',
  'vendor/ort-1.23.2/ort-wasm-simd-threaded.mjs',
  'vendor/ort-1.23.2/ort-wasm-simd-threaded.wasm',
  'vendor/ppocrv5/det.onnx',
  'vendor/ppocrv5/rec.onnx',
  'vendor/ppocrv5/dict.txt'
];
function isOcrFile(url) {
  var path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  return OCR_FILES.indexOf(path) !== -1;
}

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
        return (k === CACHE_NAME || k === OCR_CACHE) ? null : caches.delete(k);
      }));
    }).then(function () {
      // 読み取りの部品の控えからは、いまの一覧に無いもの(古い版の部品)だけを消す
      return caches.open(OCR_CACHE).then(function (c) {
        return c.keys().then(function (reqs) {
          return Promise.all(reqs.map(function (r) {
            return isOcrFile(new URL(r.url)) ? null : c.delete(r);
          }));
        });
      });
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // 外部API(商品情報の検索)はキャッシュせずネットワークのみ
  if (url.origin !== self.location.origin) return;

  if (isOcrFile(url)) {
    ev.respondWith(caches.open(OCR_CACHE).then(function (c) {
      return c.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.ok && res.type === 'basic') c.put(req, res.clone());
          return res;
        });
      });
    }));
    return;
  }

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
