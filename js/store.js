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

  /* 「その食事は食べなかった」を表す印。記録が無いのか、意図して食べなかったのかを
     区別するために、栄養値を持たない特別なエントリとして置く。
     栄養素の集計・採点では必ず除外すること。 */
  function isSkip(e) { return !!(e && e.ref && e.ref.type === 'skipped'); }
  function notSkip(e) { return !isSkip(e); }

  /* 「よく使う」と「履歴」は全記録を舐める。1.8万件の getAll に約750msかかり、
     検索のたびに読み直すと重いので、書き込みがあるまで使い回す。 */
  var allCache = null;
  function invalidate() { allCache = null; }

  function allEntries() {
    if (allCache) return Promise.resolve(allCache);
    return run('entries', 'readonly', function (s) {
      return reqp(s.getAll());
    }).then(function (rows) {
      allCache = rows || [];
      return allCache;
    });
  }

  /* ---------------- 食事エントリ ---------------- */
  var Entries = {
    /* その食事を「食べなかった」にする / 取り消す */
    /* on=true でその食事を「食べなかった」にする。戻り値は動かした記録の件数。
       記録は捨てずに印の中へ預かり、on=false で元のidのまま書き戻す。
       押し間違いで一日分が消えないようにするための作り。 */
    setSkipped: function (date, slot, on) {
      return Entries.byDate(date).then(function (rows) {
        var marks = rows.filter(function (e) { return isSkip(e) && e.slot === slot; });
        if (!on) {
          var restore = [];
          marks.forEach(function (m) {
            var kept = (m.ref && m.ref.removed) || [];
            kept.forEach(function (r) { if (r && r.date && r.slot) restore.push(r); });
          });
          return Promise.all(marks.map(function (m) { return Entries.remove(m.id, 'skip'); }))
            .then(function () {
              return restore.length ? Entries.putMany(restore) : null;
            })
            .then(function () { return restore.length; });
        }
        if (marks.length) return 0;
        var others = rows.filter(function (e) { return e.slot === slot && !isSkip(e); });
        return Promise.all(others.map(function (o) { return Entries.remove(o.id, 'skip'); }))
          .then(function () {
            return Entries.put({
              date: date, slot: slot, name: '食べなかった',
              amount: 0, unit: '', nutrients: {},
              // 取り消したときに戻せるよう、消した記録をそのまま預かる
              ref: { type: 'skipped', removed: others }
            });
          })
          .then(function () { return others.length; });
      });
    },

    isSkipped: function (rows, slot) {
      return (rows || []).some(function (e) { return isSkip(e) && e.slot === slot; });
    },

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
      invalidate();
      return run('entries', 'readwrite', function (s) {
        return reqp(s.put(rec));
      }).then(function () { return rec; });
    },
    putMany: function (records) {
      records = records || [];
      var base = Date.now();
      records.forEach(function (rec, i) {
        if (!rec.id) rec.id = uid();
        if (rec.seq == null) rec.seq = base + i;
      });
      if (!records.length) return Promise.resolve(records);
      invalidate();
      return run('entries', 'readwrite', function (s) {
        records.forEach(function (rec) { s.put(rec); });
        return records;
      });
    },
    /* why には消した理由を入れる。原因不明の消失を追えるようにするため。
       'skip'（「食べなかった」）は印の中に控えを持つので、ここでは預からない。 */
    remove: function (id, why) {
      invalidate();
      var keep = why !== 'skip'
        ? run('entries', 'readonly', function (s) { return reqp(s.get(id)); })
        : Promise.resolve(null);
      return keep.then(function (rec) {
        if (!rec) return null;
        return Settings.get().then(function (st) {
          var list = (st.trash || []).slice();
          list.unshift({ rec: rec, at: Date.now(), why: why || '削除' });
          return Settings.save({ trash: list.slice(0, 40) });
        }).catch(function () { return null; });
      }).then(function () {
        return run('entries', 'readwrite', function (s) { return reqp(s.delete(id)); });
      });
    },
    /* 控えから書き戻す。idもそのままなので、消す前と同じ記録に戻る */
    restoreTrash: function (at) {
      return Settings.get().then(function (st) {
        var list = st.trash || [];
        var hit = list.filter(function (x) { return x && x.at === at; })[0];
        if (!hit || !hit.rec) return null;
        return Entries.put(hit.rec).then(function () {
          return Settings.save({
            trash: list.filter(function (x) { return x && x.at !== at; })
          });
        }).then(function () { return hit.rec; });
      });
    },
    clearTrash: function () { return Settings.save({ trash: [] }); },
    recent: function (limit, opts) {
      opts = opts || {};
      return allEntries().then(function (rows0) {
        var rows = rows0.filter(notSkip);   // 「食べなかった」印は食品ではない
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
      return allEntries().then(function (rows0) {
        var rows = rows0.filter(notSkip);   // 「食べなかった」印は食品ではない
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
    putMany: function (records) {
      records = records || [];
      if (!records.length) return Promise.resolve(records);
      return run('combos', 'readwrite', function (s) {
        records.forEach(function (rec) { s.put(rec); });
        return records;
      });
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
  function blankBody(date) {
    return { date: date, weight: null, bodyFat: null, steps: null, activeKcal: null, custom: {},
      bowel: '', toilet: [], mealTimes: {}, memo: '' };
  }

  var Body = {
    get: function (date) {
      return run('body', 'readonly', function (s) { return reqp(s.get(date)); });
    },
    put: function (rec) {
      return run('body', 'readwrite', function (s) { return reqp(s.put(rec)); });
    },
    // 食事区分ごとの時刻だけを同一トランザクションで更新する。
    // カラダ画面の入力と競合しても、体重・歩数など既存の値を失わない。
    setMealTime: function (date, slot, value, onlyIfEmpty) {
      value = String(value || '');
      if (value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        return Promise.reject(new Error('食事時間の形式が正しくありません'));
      }
      return run('body', 'readwrite', function (s) {
        return reqp(s.get(date)).then(function (rec) {
          rec = rec || blankBody(date);
          rec.mealTimes = Object.assign({}, rec.mealTimes || {});
          if (onlyIfEmpty && rec.mealTimes[slot]) return rec;
          if (value) rec.mealTimes[slot] = value;
          else delete rec.mealTimes[slot];
          return reqp(s.put(rec)).then(function () { return rec; });
        });
      });
    },
    // 部分更新を同一トランザクションで行い、体重やメモなどを保持する。
    importSteps: function (rows) {
      // 同じ日が複数あっても最後の値1件へまとめる。既存値には加算せず、
      // 日別合計を常に置き換える。
      var byDate = {};
      (rows || []).forEach(function (row) {
        if (!row || !row.date || !Number.isFinite(Number(row.steps))) return;
        // 活動エネルギー(実測)は入っている日だけ持つ。無い日は既存値をそのまま残す
        var kcal = Number(row.activeKcal);
        byDate[row.date] = {
          steps: Math.max(0, Math.round(Number(row.steps))),
          activeKcal: Number.isFinite(kcal) && kcal >= 0 ? Math.round(kcal * 10) / 10 : null
        };
      });
      rows = Object.keys(byDate).map(function (date) {
        return { date: date, steps: byDate[date].steps, activeKcal: byDate[date].activeKcal };
      });
      return run('body', 'readwrite', function (s) {
        return Promise.all(rows.map(function (row) {
          return reqp(s.get(row.date)).then(function (rec) {
            rec = rec || blankBody(row.date);
            rec.steps = row.steps;
            if (row.activeKcal != null) rec.activeKcal = row.activeKcal;
            return reqp(s.put(rec));
          });
        })).then(function () { return rows.length; });
      });
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

  function coverageParts(entries) {
    var F = global.Foods;
    var keys = F.KEYS.concat(['sugar']);
    var denominator = 0, known = {}, estimated = {};
    (entries || []).forEach(function (e) {
      var n = e.nutrients || {};
      var kcal = (typeof n.kcal === 'number' && isFinite(n.kcal) && n.kcal > 0) ? n.kcal : 0;
      if (!kcal) return;
      denominator += kcal;
      var estKeys = (e.est && e.est.keys) || [];
      keys.forEach(function (key) {
        var present = typeof n[key] === 'number' && isFinite(n[key]);
        if (key === 'sugar' && !present) present = F.sugarOf(n) != null;
        if (!present) return;
        known[key] = (known[key] || 0) + kcal;
        if (estKeys.indexOf(key) !== -1 ||
            (key === 'sugar' && (estKeys.indexOf('carb') !== -1 || estKeys.indexOf('fiber') !== -1))) {
          estimated[key] = (estimated[key] || 0) + kcal;
        }
      });
    });
    return { denominator: denominator, known: known, estimated: estimated };
  }

  function coverageResult(parts, denominator) {
    var F = global.Foods;
    var coverage = {}, estimated = {};
    F.KEYS.concat(['sugar']).forEach(function (key) {
      coverage[key] = denominator > 0 ? Math.min(1, (parts.known[key] || 0) / denominator) : 0;
      estimated[key] = denominator > 0 ? Math.min(1, (parts.estimated[key] || 0) / denominator) : 0;
    });
    if (denominator > 0) coverage.kcal = 1;
    return { coverage: coverage, estimated: estimated };
  }

  function dayTotals(date, entries) {
    // 「食べなかった」印は栄養値を持たないので、集計の判定から外す
    entries = (entries || []).filter(notSkip);
    var F = global.Foods;
    var sumAll = F.sum(entries.map(function (e) { return e.nutrients; }));
    var fromImport = entries.filter(isImported);
    var own = entries.filter(function (e) { return !isImported(e); });

    return Daily.get(date).then(function (imp) {
      var usable = imp && imp.nutrients && (fromImport.length > 0 || entries.length === 0);
      if (!usable) {
        var sugar = F.sugarOf(sumAll);
        if (sugar != null) sumAll.sugar = sugar; else delete sumAll.sugar;
        var regular = coverageParts(entries);
        var rc = coverageResult(regular, regular.denominator);
        return { totals: sumAll, imported: null, coverage: rc.coverage, estimated: rc.estimated };
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
      var sugar2 = F.sugarOf(out);
      if (sugar2 != null) out.sugar = sugar2; else delete out.sugar;

      // 取り込み元の日次集計は実測集計として扱い、自分で追加した食品だけ個別に判定する。
      var ownCoverage = coverageParts(own);
      var totalKcal = (typeof out.kcal === 'number' && out.kcal > 0) ? out.kcal : 0;
      var importedKcal = Math.max(0, totalKcal - ownCoverage.denominator);
      var parts = { denominator: totalKcal, known: {}, estimated: {} };
      F.KEYS.concat(['sugar']).forEach(function (key) {
        var impKnown = key === 'sugar'
          ? (typeof imp.nutrients.carb === 'number' && typeof imp.nutrients.fiber === 'number')
          : (typeof imp.nutrients[key] === 'number');
        parts.known[key] = (ownCoverage.known[key] || 0) + (impKnown ? importedKcal : 0);
        parts.estimated[key] = ownCoverage.estimated[key] || 0;
      });
      var ic = coverageResult(parts, totalKcal);
      return { totals: out, imported: imp, coverage: ic.coverage, estimated: ic.estimated };
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
    byName: function (name) {
      var key = global.Foods && global.Foods.norm
        ? global.Foods.norm(name) : String(name || '').trim().toLowerCase();
      if (!key) return Promise.resolve(null);
      return MyFoods.all().then(function (rows) {
        for (var i = 0; i < rows.length; i++) {
          var rowKey = global.Foods && global.Foods.norm
            ? global.Foods.norm(rows[i].name) : String(rows[i].name || '').trim().toLowerCase();
          if (rowKey === key) return rows[i];
        }
        return null;
      });
    },
    put: function (rec) {
      if (!rec.id) rec.id = uid();
      if (rec.barcode == null) rec.barcode = '';
      rec.usedAt = rec.usedAt || Date.now();
      return run('myfoods', 'readwrite', function (s) { return reqp(s.put(rec)); })
        .then(function () { return rec; });
    },
    putMany: function (records) {
      records = records || [];
      var base = Date.now();
      records.forEach(function (rec, i) {
        if (!rec.id) rec.id = uid();
        if (rec.barcode == null) rec.barcode = '';
        rec.usedAt = rec.usedAt || base + i;
      });
      if (!records.length) return Promise.resolve(records);
      return run('myfoods', 'readwrite', function (s) {
        records.forEach(function (rec) { s.put(rec); });
        return records;
      });
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
    exerciseKcalGoal: 322,    // 運動・歩数由来の1日消費目標
    customFields: [           // カラダ記録の任意項目
      { id: 'kintore', label: '筋トレ', type: 'count', unit: '回' }
    ],
    toiletTypes: ['小'],
    toiletMigrated: 0,
    exerciseGoal322Migrated: 0, // 旧既定値200kcalを322kcalへ移した版
    chickenLiver11232Migrated: 0, // 旧レバー推定(11197)を鶏肝(11232)へ移した版
    trash: [],                // 消した記録の控え(最大40件)。設定から戻せる
    lastTab: 'meal',
    lastAddSrc: 'used',       // 追加シートで最後に見ていた区分
    lastHistSlot: '',         // 履歴の絞り込み(朝食/昼食/夕食/間食、空なら全部)
    skipBackfilled: 0         // 取り込み済みの日の未記録を「食べなかった」で埋めた版
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

  /* 取り込み済み(あすけん等の日次集計がある)の日で、食事の記録が1件も無い区分を
     「食べなかった」で埋める。あすけん側で入力が無い＝食べなかった、という前提。
     一度だけ走らせる。今日と未来の日には触らない。 */
  var SLOT_KEYS = ['breakfast', 'lunch', 'dinner', 'snack'];

  function backfillSkipped() {
    var today = ymd(new Date());
    return Promise.all([Daily.all(), Settings.get()]).then(function (r) {
      var days = r[0].filter(function (d) { return d.date < today; });
      if (!days.length) return { added: 0, days: 0 };
      var want = {};
      days.forEach(function (d) { want[d.date] = 1; });
      return run('entries', 'readonly', function (s2) {
        return reqp(s2.getAll());
      }).then(function (rows) {
        var have = {};
        (rows || []).forEach(function (e) {
          if (!want[e.date]) return;
          have[e.date + '|' + e.slot] = 1;
        });
        var add = [];
        Object.keys(want).forEach(function (d) {
          SLOT_KEYS.forEach(function (sl) {
            if (have[d + '|' + sl]) return;
            add.push({
              id: uid(), seq: Date.now(), date: d, slot: sl, name: '食べなかった',
              amount: 0, unit: '', nutrients: {}, ref: { type: 'skipped' }
            });
          });
        });
        if (!add.length) return { added: 0, days: days.length };
        invalidate();
        return run('entries', 'readwrite', function (s3) {
          add.forEach(function (rec) { s3.put(rec); });
          return true;
        }).then(function () { return { added: add.length, days: days.length }; });
      });
    });
  }

  // ボタン設定だけを移行する。既存の「大」の記録は削除・変換しない。
  function migrateToilet() {
    return Settings.get().then(function (st) {
      if (st.toiletMigrated) return st;
      var types = (st.toiletTypes || []).filter(function (x) { return x !== '大'; });
      return Settings.save({ toiletTypes: types.length ? types : ['小'], toiletMigrated: 1 });
    });
  }

  // v13より前の既定値200kcalだけを322kcalへ移す。利用者が自分で設定した
  // 200以外の値は維持し、移行後に200へ戻しても再変更しない。
  function migrateExerciseGoal() {
    return Settings.get().then(function (st) {
      if (st.exerciseGoal322Migrated) return st;
      return Settings.save({
        exerciseKcalGoal: st.exerciseKcalGoal === 200 ? 322 : st.exerciseKcalGoal,
        exerciseGoal322Migrated: 1
      });
    });
  }

  // 保存済みの旧「レバー」推定だけを鶏肝11232へ再較正する。
  // 食事記録・マイ食品・食品セットを一緒に直し、再追加時の旧値流入も防ぐ。
  function migrateChickenLiver() {
    return Settings.get().then(function (st) {
      if (st.chickenLiver11232Migrated) {
        return { entries: 0, myfoods: 0, combos: 0, changed: 0, skipped: true };
      }
      var estimator = global.Estimate;
      if (!estimator || !estimator.recalibrateChickenLiver) {
        return Promise.reject(new Error('鶏レバーの較正処理を読み込めませんでした'));
      }
      return Promise.all([
        estimator.load(), allEntries(), MyFoods.all(), Combos.all()
      ]).then(function (r) {
        var entries = r[1] || [], myfoods = r[2] || [], combos = r[3] || [];
        var entryJobs = entries.filter(estimator.isLegacyChickenLiver).map(function (rec) {
          return estimator.recalibrateChickenLiver(rec, {
            unit: rec.unit || 'g', amount: rec.amount || 1
          });
        });
        var foodJobs = myfoods.filter(estimator.isLegacyChickenLiver).map(function (rec) {
          return estimator.recalibrateChickenLiver(rec, {
            unit: rec.basis === 'serving' ? (rec.servingLabel || '食') : 'g',
            amount: rec.basis === 'serving' ? 1 : 100
          });
        });
        var comboJobs = combos.filter(function (combo) {
          return (combo.items || []).some(estimator.isLegacyChickenLiver);
        }).map(function (combo) {
          var items = combo.items || [];
          return Promise.all(items.map(function (item) {
            return estimator.recalibrateChickenLiver(item, {
              unit: item.unit || 'g', amount: item.amount || 1
            });
          })).then(function (nextItems) {
            if (!nextItems.some(Boolean)) return null;
            var next = {};
            for (var key in combo) next[key] = combo[key];
            next.items = items.map(function (item, i) { return nextItems[i] || item; });
            return next;
          });
        });
        return Promise.all([
          Promise.all(entryJobs), Promise.all(foodJobs), Promise.all(comboJobs)
        ]);
      }).then(function (groups) {
        var changedEntries = groups[0].filter(Boolean);
        var changedFoods = groups[1].filter(Boolean);
        var changedCombos = groups[2].filter(Boolean);
        invalidate();
        return run(['entries', 'myfoods', 'combos', 'settings'], 'readwrite', function (stores) {
          changedEntries.forEach(function (rec) { stores[0].put(rec); });
          changedFoods.forEach(function (rec) { stores[1].put(rec); });
          changedCombos.forEach(function (rec) { stores[2].put(rec); });
          st.chickenLiver11232Migrated = 1;
          stores[3].put({ k: 'main', v: st });
          return true;
        }).then(function () {
          var result = {
            entries: changedEntries.length, myfoods: changedFoods.length,
            combos: changedCombos.length,
            changed: changedEntries.length + changedFoods.length + changedCombos.length
          };
          return result;
        });
      });
    });
  }

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
    invalidate();
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
    invalidate();
    return run(['entries', 'body', 'exercise', 'myfoods', 'daily', 'combos'], 'readwrite', function (st) {
      st.forEach(function (s) { s.clear(); });
      return true;
    });
  }

  global.Store = {
    uid: uid, ymd: ymd, parseYmd: parseYmd, shiftYmd: shiftYmd,
    Entries: Entries, Body: Body, Exercise: Exercise, MyFoods: MyFoods,
    Settings: Settings, Daily: Daily, Combos: Combos, dayTotals: dayTotals,
    isSkip: isSkip, notSkip: notSkip, backfillSkipped: backfillSkipped,
    exportAll: exportAll, importAll: importAll, wipeAll: wipeAll,
    migrateToilet: migrateToilet, migrateExerciseGoal: migrateExerciseGoal,
    migrateChickenLiver: migrateChickenLiver,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS
  };
})(window);
