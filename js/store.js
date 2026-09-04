/* store.js - IndexedDB 永続化層
   すべてのデータは端末内にのみ保存される。サーバへは一切送信しない。 */
(function (global) {
  'use strict';

  var DB_NAME = 'meallog';
  var DB_VER = 3;
  var dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (ev) {
        var db = req.result;
        if (!db.objectStoreNames.contains('entries')) {
          var e = db.createObjectStore('entries', { keyPath: 'id' });
          e.createIndex('date', 'date');
        }
        if (!db.objectStoreNames.contains('body')) {
          db.createObjectStore('body', { keyPath: 'date' });
        }
        if (!db.objectStoreNames.contains('exercise')) {
          var x = db.createObjectStore('exercise', { keyPath: 'id' });
          x.createIndex('date', 'date');
        }
        if (!db.objectStoreNames.contains('myfoods')) {
          var m = db.createObjectStore('myfoods', { keyPath: 'id' });
          m.createIndex('barcode', 'barcode');
          m.createIndex('used', 'usedAt');
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'k' });
        }
        // 他アプリから取り込んだ「その日の栄養素合計」(個々の食品に栄養値が無い場合の補完用)
        if (!db.objectStoreNames.contains('daily')) {
          db.createObjectStore('daily', { keyPath: 'date' });
        }
        // 自分で組み合わせた食事(例:「魚定食」= サバ + ごはん + 豆腐 + 納豆)
        if (!db.objectStoreNames.contains('combos')) {
          var cb = db.createObjectStore('combos', { keyPath: 'id' });
          cb.createIndex('used', 'usedAt');
        }
        void ev;
      };
      req.onsuccess = function () {
        var db = req.result;
        // iOS が長時間バックグラウンド後に接続を閉じる問題への備え
        db.onclose = function () { dbp = null; };
        resolve(db);
      };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }

  // closing 検出時に一度だけ再接続してリトライする
  function run(storeNames, mode, fn) {
    return open().then(function (db) {
      return exec(db, storeNames, mode, fn);
    }).catch(function (err) {
      var msg = String((err && err.message) || err);
      if (msg.indexOf('closing') === -1 && msg.indexOf('InvalidStateError') === -1) throw err;
      dbp = null;
      return open().then(function (db) { return exec(db, storeNames, mode, fn); });
    });
  }

  function exec(db, storeNames, mode, fn) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeNames, mode);
      var out;
      tx.oncomplete = function () { resolve(out); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error); };
      var stores = (typeof storeNames === 'string')
        ? tx.objectStore(storeNames)
        : storeNames.map(function (n) { return tx.objectStore(n); });
      out = fn(stores, tx);
      if (out && typeof out.then === 'function') {
        out.then(function (v) { out = v; }, reject);
      }
    });
  }

  function reqp(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /* ---------------- 日付ユーティリティ ---------------- */
  function ymd(d) {
    d = d || new Date();
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }
  function parseYmd(s) {
    var p = String(s).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function shiftYmd(s, days) {
    var d = parseYmd(s);
    d.setDate(d.getDate() + days);
    return ymd(d);
  }

  /* ---------------- 食事エントリ ---------------- */
  var Entries = {
    byDate: function (date) {
      return run('entries', 'readonly', function (s) {
        return reqp(s.index('date').getAll(IDBKeyRange.only(date)));
      }).then(function (rows) {
        return (rows || []).sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
      });
    },
    range: function (from, to) {
      return run('entries', 'readonly', function (s) {
        return reqp(s.index('date').getAll(IDBKeyRange.bound(from, to)));
      });
    },
    put: function (rec) {
      if (!rec.id) rec.id = uid();
      if (rec.seq == null) rec.seq = Date.now();
      return run('entries', 'readwrite', function (s) {
        return reqp(s.put(rec));
      }).then(function () { return rec; });
    },
    remove: function (id) {
      return run('entries', 'readwrite', function (s) { return reqp(s.delete(id)); });
    },
    recent: function (limit, opts) {
      opts = opts || {};
      return run('entries', 'readonly', function (s) {
        return reqp(s.getAll());
      }).then(function (rows) {
        if (opts.slot) {
          rows = rows.filter(function (r) { return r.slot === opts.slot; });
        }
        rows.sort(function (a, b) { return (b.seq || 0) - (a.seq || 0); });
        var seen = {}, out = [];
        for (var i = 0; i < rows.length && out.length < (limit || 60); i++) {
          var key = rows[i].name + '|' + (rows[i].grams || '');
          if (seen[key]) continue;
          seen[key] = 1;
          out.push(rows[i]);
        }
        return out;
      });
    },

    /* 実際に食べた回数のランキング。「よく使う」はこれを出す。
       同じ食品名でまとめ、最後に食べた日と代表的な分量を添える。 */
    topUsed: function (limit, opts) {
      opts = opts || {};
      return run('entries', 'readonly', function (s) {
        return reqp(s.getAll());
      }).then(function (rows) {
        rows = rows || [];
        if (opts.slot) rows = rows.filter(function (r) { return r.slot === opts.slot; });
        if (opts.since) rows = rows.filter(function (r) { return r.date >= opts.since; });
        var map = {};
        rows.forEach(function (r) {
          var k = r.name;
          var g = map[k];
          if (!g) {
            g = map[k] = { name: r.name, count: 0, last: '', latest: r, amounts: {} };
          }
          g.count++;
          var a = String(r.amount) + '|' + (r.unit || 'g');
          g.amounts[a] = (g.amounts[a] || 0) + 1;
          if (!g.last || r.date > g.last) { g.last = r.date; g.latest = r; }
        });
        var out = [];
        for (var k2 in map) {
          var g2 = map[k2];
          // 一番よく使った分量を代表にする
          var best = null, bestN = -1;
          for (var a2 in g2.amounts) {
            if (g2.amounts[a2] > bestN) { bestN = g2.amounts[a2]; best = a2; }
          }
          var pa = String(best || '').split('|');
          g2.topAmount = parseFloat(pa[0]);
          g2.topUnit = pa[1] || 'g';
          delete g2.amounts;
          out.push(g2);
        }
        out.sort(function (a, b) {
          if (b.count !== a.count) return b.count - a.count;
          return a.last < b.last ? 1 : -1;
        });
        return out.slice(0, limit || 60);
      });
    }
  };

  /* ---------------- 自分で組み合わせた食事(セット) ---------------- */
  var Combos = {
    all: function () {
      return run('combos', 'readonly', function (s) { return reqp(s.getAll()); })
        .then(function (rows) {
          return (rows || []).sort(function (a, b) {
            if ((b.useCount || 0) !== (a.useCount || 0)) return (b.useCount || 0) - (a.useCount || 0);
            return (b.usedAt || 0) - (a.usedAt || 0);
          });
        });
    },
    get: function (id) {
      return run('combos', 'readonly', function (s) { return reqp(s.get(id)); });
    },
    put: function (rec) {
      if (!rec.id) rec.id = uid();
      if (rec.useCount == null) rec.useCount = 0;
      if (rec.usedAt == null) rec.usedAt = 0;
      return run('combos', 'readwrite', function (s) { return reqp(s.put(rec)); })
        .then(function () { return rec; });
    },
    remove: function (id) {
      return run('combos', 'readwrite', function (s) { return reqp(s.delete(id)); });
    },
    touch: function (id) {
      return run('combos', 'readwrite', function (s) {
        return reqp(s.get(id)).then(function (r) {
          if (!r) return null;
          r.useCount = (r.useCount || 0) + 1;
          r.usedAt = Date.now();
          return reqp(s.put(r));
        });
      });
    }
  };

  /* ---------------- カラダ記録 ---------------- */
  var Body = {
    get: function (date) {
      return run('body', 'readonly', function (s) { return reqp(s.get(date)); });
    },
    put: function (rec) {
      return run('body', 'readwrite', function (s) { return reqp(s.put(rec)); });
    },
    all: function () {
      return run('body', 'readonly', function (s) { return reqp(s.getAll()); })
        .then(function (rows) {
          return (rows || []).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
        });
    },
    latestWeight: function (onOrBefore) {
      return Body.all().then(function (rows) {
        for (var i = rows.length - 1; i >= 0; i--) {
          if (rows[i].weight && (!onOrBefore || rows[i].date <= onOrBefore)) return rows[i];
        }
        return null;
      });
    }
  };

  /* ---------------- 取り込んだ日次栄養素(あすけん等) ---------------- */
  var Daily = {
    get: function (date) {
      return run('daily', 'readonly', function (s) { return reqp(s.get(date)); });
    },
    put: function (rec) {
      return run('daily', 'readwrite', function (s) { return reqp(s.put(rec)); });
    },
    all: function () {
      return run('daily', 'readonly', function (s) { return reqp(s.getAll()); })
        .then(function (rows) {
          return (rows || []).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
        });
    },
    range: function (from, to) {
      return Daily.all().then(function (rows) {
        return rows.filter(function (r) { return r.date >= from && r.date <= to; });
      });
    }
  };

  /* その日の栄養素合計。記録した食品の合計を基本にし、
     食品側に値が無い項目だけ取り込みデータ(あすけん等)で補う。 */
  function isImported(e) { return !!(e.ref && e.ref.type === 'asken'); }

  function dayTotals(date, entries) {
    entries = entries || [];
    var F = global.Foods;
    var sumAll = F.sum(entries.map(function (e) { return e.nutrients; }));
    var fromImport = entries.filter(isImported);
    var own = entries.filter(function (e) { return !isImported(e); });

    return Daily.get(date).then(function (imp) {
      var usable = imp && imp.nutrients && (fromImport.length > 0 || entries.length === 0);
      if (!usable) {
        sumAll.sugar = F.sugarOf(sumAll);
        return { totals: sumAll, imported: null };
      }
      // カロリーは食品ごとに持っているのでそのまま。それ以外は取り込み元の日次集計を使い、
      // 自分で足した食品(成分表など)の分だけ上乗せする。
      var ownSum = F.sum(own.map(function (e) { return e.nutrients; }));
      var out = {};
      for (var k in sumAll) out[k] = sumAll[k];
      for (var key in imp.nutrients) {
        if (key === 'kcal') continue;
        var v = imp.nutrients[key];
        if (typeof v !== 'number') continue;
        out[key] = F.round(v + (ownSum[key] || 0), 2);
      }
      if (!out.kcal && imp.nutrients.kcal) out.kcal = imp.nutrients.kcal;
      out.sugar = F.sugarOf(out);
      return { totals: out, imported: imp };
    });
  }

  /* ---------------- 運動記録 ---------------- */
  var Exercise = {
    byDate: function (date) {
      return run('exercise', 'readonly', function (s) {
        return reqp(s.index('date').getAll(IDBKeyRange.only(date)));
      });
    },
    range: function (from, to) {
      return run('exercise', 'readonly', function (s) {
        return reqp(s.index('date').getAll(IDBKeyRange.bound(from, to)));
      });
    },
    put: function (rec) {
      if (!rec.id) rec.id = uid();
      return run('exercise', 'readwrite', function (s) { return reqp(s.put(rec)); })
        .then(function () { return rec; });
    },
    remove: function (id) {
      return run('exercise', 'readwrite', function (s) { return reqp(s.delete(id)); });
    }
  };

  /* ---------------- マイ食品(自作・バーコード紐付け) ---------------- */
  var MyFoods = {
    all: function () {
      return run('myfoods', 'readonly', function (s) { return reqp(s.getAll()); })
        .then(function (rows) {
          return (rows || []).sort(function (a, b) { return (b.usedAt || 0) - (a.usedAt || 0); });
        });
    },
    get: function (id) {
      return run('myfoods', 'readonly', function (s) { return reqp(s.get(id)); });
    },
    byBarcode: function (code) {
      return run('myfoods', 'readonly', function (s) {
        return reqp(s.index('barcode').getAll(IDBKeyRange.only(String(code))));
      }).then(function (rows) { return (rows && rows[0]) || null; });
    },
    put: function (rec) {
      if (!rec.id) rec.id = uid();
      if (rec.barcode == null) rec.barcode = '';
      rec.usedAt = rec.usedAt || Date.now();
      return run('myfoods', 'readwrite', function (s) { return reqp(s.put(rec)); })
        .then(function () { return rec; });
    },
    touch: function (id) {
      return MyFoods.get(id).then(function (rec) {
        if (!rec) return null;
        rec.usedAt = Date.now();
        rec.useCount = (rec.useCount || 0) + 1;
        return MyFoods.put(rec);
      });
    },
    remove: function (id) {
      return run('myfoods', 'readwrite', function (s) { return reqp(s.delete(id)); });
    }
  };

  /* ---------------- 設定 ---------------- */
  var DEFAULT_SETTINGS = {
    sex: 'male',
    birth: '',
    heightCm: 170,
    activity: 1.75,           // 身体活動レベル(低1.50/普通1.75/高2.00)
    goalWeight: null,
    goalDate: '',
    paceKgPerMonth: 2,        // 減量ペース
    manualKcal: null,         // 手動で目標kcalを上書き
    customFields: [           // カラダ記録の任意項目
      { id: 'kintore', label: '筋トレ', type: 'count', unit: '回' }
    ],
    toiletTypes: ['小', '大'],
    lastTab: 'meal',
    lastAddSrc: 'used',       // 追加シートで最後に見ていた区分
    lastHistSlot: ''          // 履歴の絞り込み(朝食/昼食/夕食/間食、空なら全部)
  };

  var Settings = {
    get: function () {
      return run('settings', 'readonly', function (s) { return reqp(s.get('main')); })
        .then(function (rec) {
          var v = (rec && rec.v) || {};
          var out = {};
          for (var k in DEFAULT_SETTINGS) out[k] = (v[k] !== undefined) ? v[k] : DEFAULT_SETTINGS[k];
          return out;
        });
    },
    save: function (obj) {
      return Settings.get().then(function (cur) {
        for (var k in obj) cur[k] = obj[k];
        return run('settings', 'readwrite', function (s) {
          return reqp(s.put({ k: 'main', v: cur }));
        }).then(function () { return cur; });
      });
    }
  };

  /* ---------------- 全データ書き出し/取り込み ---------------- */
  function exportAll() {
    return Promise.all([
      run('entries', 'readonly', function (s) { return reqp(s.getAll()); }),
      run('body', 'readonly', function (s) { return reqp(s.getAll()); }),
      run('exercise', 'readonly', function (s) { return reqp(s.getAll()); }),
      run('myfoods', 'readonly', function (s) { return reqp(s.getAll()); }),
      Settings.get(),
      run('daily', 'readonly', function (s) { return reqp(s.getAll()); }),
      run('combos', 'readonly', function (s) { return reqp(s.getAll()); })
    ]).then(function (r) {
      return {
        app: 'meallog', version: 3, exportedAt: new Date().toISOString(),
        entries: r[0], body: r[1], exercise: r[2], myfoods: r[3], settings: r[4],
        daily: r[5], combos: r[6]
      };
    });
  }

  function importAll(data, mode) {
    if (!data || data.app !== 'meallog') return Promise.reject(new Error('形式が違います'));
    var replace = (mode === 'replace');
    return run(['entries', 'body', 'exercise', 'myfoods', 'settings', 'daily', 'combos'],
      'readwrite', function (st) {
        var entries = st[0], body = st[1], ex = st[2], my = st[3], se = st[4], da = st[5], cb = st[6];
        if (replace) { entries.clear(); body.clear(); ex.clear(); my.clear(); da.clear(); cb.clear(); }
        (data.entries || []).forEach(function (r) { entries.put(r); });
        (data.body || []).forEach(function (r) { body.put(r); });
        (data.exercise || []).forEach(function (r) { ex.put(r); });
        (data.myfoods || []).forEach(function (r) { my.put(r); });
        (data.daily || []).forEach(function (r) { da.put(r); });
        (data.combos || []).forEach(function (r) { cb.put(r); });
        if (data.settings) se.put({ k: 'main', v: data.settings });
        return true;
      });
  }

  function wipeAll() {
    return run(['entries', 'body', 'exercise', 'myfoods', 'daily', 'combos'], 'readwrite', function (st) {
      st.forEach(function (s) { s.clear(); });
      return true;
    });
  }

  global.Store = {
    uid: uid, ymd: ymd, parseYmd: parseYmd, shiftYmd: shiftYmd,
    Entries: Entries, Body: Body, Exercise: Exercise, MyFoods: MyFoods,
    Settings: Settings, Daily: Daily, Combos: Combos, dayTotals: dayTotals,
    exportAll: exportAll, importAll: importAll, wipeAll: wipeAll,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS
  };
})(window);
