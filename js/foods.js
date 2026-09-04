/* foods.js - 日本食品標準成分表(八訂)増補2023年 の検索と栄養素計算 */
(function (global) {
  'use strict';

  var DB = null;          // {groups, foods:[...]}
  var loading = null;
  var NUTRIENT_KEYS = [
    'kcal', 'protein', 'fat', 'carb', 'fiber', 'salt', 'satfat', 'monofat', 'polyfat',
    'n3', 'n6', 'chol', 'k', 'ca', 'mg', 'fe', 'zn',
    'vita', 'vitd', 'vite', 'vitb1', 'vitb2', 'niacin', 'vitb6', 'vitb12', 'folate', 'vitc'
  ];

  // 表示名(日本語)と単位
  var NUTRIENT_META = {
    kcal: ['エネルギー', 'kcal'], protein: ['たんぱく質', 'g'], fat: ['脂質', 'g'],
    carb: ['炭水化物', 'g'], sugar: ['糖質', 'g'], fiber: ['食物繊維', 'g'],
    salt: ['食塩相当量', 'g'], satfat: ['飽和脂肪酸', 'g'], monofat: ['一価不飽和', 'g'],
    polyfat: ['多価不飽和', 'g'], n3: ['n-3系脂肪酸', 'g'], n6: ['n-6系脂肪酸', 'g'],
    chol: ['コレステロール', 'mg'], k: ['カリウム', 'mg'], ca: ['カルシウム', 'mg'],
    mg: ['マグネシウム', 'mg'], fe: ['鉄', 'mg'], zn: ['亜鉛', 'mg'],
    vita: ['ビタミンA', 'µg'], vitd: ['ビタミンD', 'µg'], vite: ['ビタミンE', 'mg'],
    vitb1: ['ビタミンB1', 'mg'], vitb2: ['ビタミンB2', 'mg'], niacin: ['ナイアシン', 'mg'],
    vitb6: ['ビタミンB6', 'mg'], vitb12: ['ビタミンB12', 'µg'], folate: ['葉酸', 'µg'],
    vitc: ['ビタミンC', 'mg']
  };

  /* 日常語 -> 成分表の用語 を補う辞書。
     q     = 追加で AND 検索する語 / prefer = この語を含むものを最優先にする */
  var ALIASES = {
    'ごはん':   { q: 'こめ 水稲めし 精白米', prefer: 'うるち米' },
    'ご飯':     { q: 'こめ 水稲めし 精白米', prefer: 'うるち米' },
    'ライス':   { q: 'こめ 水稲めし 精白米', prefer: 'うるち米' },
    '白米':     { q: 'こめ 水稲めし 精白米', prefer: 'うるち米' },
    '玄米':     { q: 'こめ 水稲めし', prefer: '玄米' },
    'パン':     { q: 'こむぎ パン類', prefer: '角形食パン 食パン' },
    '食パン':   { q: 'こむぎ 角形食パン', prefer: '角形食パン 食パン' },
    'うどん':   { q: 'うどん', prefer: 'うどん ゆで' },
    'そば':     { q: 'そば', prefer: 'そば そば ゆで' },
    'ラーメン': { q: '中華めん', prefer: '中華めん ゆで' },
    'パスタ':   { q: 'マカロニ スパゲッティ', prefer: 'ゆで' },
    'スパゲティ': { q: 'マカロニ スパゲッティ', prefer: 'ゆで' },
    'たまご':   { q: '鶏卵', prefer: '全卵 生' },
    '玉子':     { q: '鶏卵', prefer: '全卵 生' },
    '卵':       { q: '鶏卵', prefer: '全卵 生' },
    'ゆで卵':   { q: '鶏卵 全卵 ゆで', prefer: '全卵 ゆで' },
    '牛乳':     { q: '普通牛乳', prefer: '普通牛乳' },
    'ヨーグルト': { q: 'ヨーグルト', prefer: '全脂無糖' },
    'チーズ':   { q: 'チーズ', prefer: 'プロセスチーズ' },
    '鶏むね':   { q: 'にわとり むね', prefer: '若どり むね 皮なし 生' },
    '鶏もも':   { q: 'にわとり もも', prefer: '若どり もも 皮つき 生' },
    'ささみ':   { q: 'にわとり ささみ', prefer: '若どり ささみ 生' },
    '豚バラ':   { q: 'ぶた ばら', prefer: '大型種肉 ばら 脂身つき 生' },
    '豚ロース': { q: 'ぶた ロース', prefer: '大型種肉 ロース 脂身つき 生' },
    '牛肉':     { q: 'うし', prefer: '輸入牛肉 もも 赤肉 生' },
    '納豆':     { q: '糸引き納豆', prefer: '糸引き納豆' },
    '豆腐':     { q: '豆腐', prefer: '木綿豆腐' },
    'とうふ':   { q: '豆腐', prefer: '木綿豆腐' },
    'キャベツ': { q: 'キャベツ 結球葉', prefer: 'キャベツ 結球葉 生' },
    'トマト':   { q: 'トマト', prefer: '赤色トマト 果実 生' },
    'にんじん': { q: 'にんじん 根', prefer: '皮なし 生' },
    'たまねぎ': { q: 'たまねぎ りん茎', prefer: 'たまねぎ りん茎 生' },
    'じゃがいも': { q: 'じゃがいも 塊茎', prefer: '皮なし 生' },
    'バナナ':   { q: 'バナナ', prefer: 'バナナ 生' },
    'りんご':   { q: 'りんご', prefer: 'りんご 皮なし 生' },
    'ビール':   { q: 'ビール', prefer: 'ビール 淡色' },
    'コーヒー': { q: 'コーヒー', prefer: 'コーヒー 浸出液' },
    'お茶':     { q: '茶', prefer: 'せん茶 浸出液' },
    'みそ':     { q: 'みそ', prefer: '米みそ 淡色辛みそ' },
    'みそ汁':   { q: 'みそ', prefer: '米みそ 淡色辛みそ' },
    '味噌汁':   { q: 'みそ', prefer: '米みそ 淡色辛みそ' },
    'さけ':     { q: 'さけ', prefer: 'しろさけ 生' },
    'ツナ':     { q: 'まぐろ 缶詰', prefer: '油漬 フレーク ライト' },
    'ハム':     { q: 'ハム', prefer: 'ロースハム ロースハム' },
    'ソーセージ': { q: 'ソーセージ', prefer: 'ウインナーソーセージ ウインナーソーセージ' }
  };

  /* 別名が指す「これ」という1品目(食品番号)。prefer より強く効かせる */
  var ALIAS_ID = {
    'ごはん': '01088', 'ご飯': '01088', 'ライス': '01088', '白米': '01088', '玄米': '01085',
    'パン': '01026', '食パン': '01026', 'うどん': '01039', 'そば': '01128', 'ラーメン': '01048',
    'パスタ': '01064', 'スパゲティ': '01064',
    'たまご': '12004', '玉子': '12004', '卵': '12004', 'ゆで卵': '12005',
    '牛乳': '13003', 'ヨーグルト': '13025', 'チーズ': '13040',
    '鶏むね': '11220', '鶏もも': '11221', 'ささみ': '11227',
    '豚バラ': '11129', '豚ロース': '11123', '牛肉': '11077',
    '納豆': '04046', '豆腐': '04032', 'とうふ': '04032',
    'キャベツ': '06061', 'トマト': '06182', 'にんじん': '06214', 'たまねぎ': '06153',
    'じゃがいも': '02017', 'バナナ': '07107', 'りんご': '07148',
    'ビール': '16006', 'コーヒー': '16045',
    'みそ': '17045', 'みそ汁': '17045', '味噌汁': '17045',
    'さけ': '10134', 'ツナ': '10263', 'ハム': '11176', 'ソーセージ': '11186'
  };

  /* ---- 文字正規化: カタカナ->ひらがな, 全角英数->半角, 記号除去 ---- */
  function norm(s) {
    if (!s) return '';
    s = String(s).toLowerCase();
    s = s.replace(/[！-～]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
    });
    s = s.replace(/[ァ-ヶ]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0x60);
    });
    s = s.replace(/[\s　\-ー_,、。・（）()\[\]【】]/g, '');
    return s;
  }

  function load() {
    if (DB) return Promise.resolve(DB);
    if (loading) return loading;
    loading = fetch('data/foods.json', { cache: 'force-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('食品DBの読み込みに失敗 (' + r.status + ')');
        return r.json();
      })
      .then(function (json) {
        json.foods.forEach(function (f) {
          f._n = norm(f.n);
          // 主名称(最初の空白まで)。「こむぎ [パン類] 食パン」の "こむぎ"
          f._head = norm(String(f.n).split(' ')[0]);
        });
        DB = json;
        return DB;
      });
    return loading;
  }

  /* ---- 検索 ----
     ①入力語そのものの一致 ②別名のAND一致 ③別名のOR一致 の順に強く評価し、
     別名の prefer に挙げた語をすべて含むものを最上位に押し上げる。 */
  function search(query, opts) {
    opts = opts || {};
    var limit = opts.limit || 60;
    return load().then(function (db) {
      var raw = String(query || '').trim();
      if (!raw) return [];
      var q = norm(raw);

      // 入力に含まれる別名のうち、最も長いキーを採用する(「ゆで卵」を「卵」より優先)
      var key = null;
      Object.keys(ALIASES).forEach(function (k) {
        if (raw.indexOf(k) !== -1 && (!key || k.length > key.length)) key = k;
      });
      var alias = key ? ALIASES[key] : null;
      var andTerms = alias ? alias.q.split(' ').map(norm).filter(Boolean) : [];
      var preferTerms = (alias && alias.prefer) ? alias.prefer.split(' ').map(norm).filter(Boolean) : [];
      var preferId = key ? ALIAS_ID[key] : null;

      var hits = [];
      for (var i = 0; i < db.foods.length; i++) {
        var f = db.foods[i];
        var sc = 0;

        if (f._n.indexOf(q) !== -1) {
          sc = (f._head.indexOf(q) === 0) ? 120 : (f._n.indexOf(q) === 0 ? 100 : 70);
        }
        if (andTerms.length) {
          var nAnd = 0;
          for (var t = 0; t < andTerms.length; t++) {
            if (f._n.indexOf(andTerms[t]) !== -1) nAnd++;
          }
          if (nAnd === andTerms.length) sc = Math.max(sc, 90);
          else if (nAnd > 0) sc = Math.max(sc, 30 + nAnd * 10);
        }
        if (!sc) continue;

        // 別名が指す「一番よく使う品目」を最上位へ
        if (preferId && f.id === preferId) sc += 2000;
        if (preferTerms.length) {
          var nPref = 0;
          for (var p = 0; p < preferTerms.length; p++) {
            if (f._n.indexOf(preferTerms[p]) !== -1) nPref++;
          }
          if (nPref === preferTerms.length) sc += 400;
          else sc += nPref * 8;
        }
        // 短い名前(=素材そのもの)をやや優先
        sc += Math.max(0, 30 - f.n.length) * 0.4;
        hits.push({ f: f, sc: sc });
      }
      hits.sort(function (a, b) { return b.sc - a.sc; });
      return hits.slice(0, limit).map(function (h) { return h.f; });
    });
  }

  /* ---- よく使う食品(友好名+標準分量) ---- */
  var COMMON = null, commonLoading = null;
  function loadCommon() {
    if (COMMON) return Promise.resolve(COMMON);
    if (commonLoading) return commonLoading;
    commonLoading = fetch('data/common.json', { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.json() : { cats: [], items: [] }; })
      .then(function (j) { COMMON = j; return j; })
      .catch(function () { COMMON = { cats: [], items: [] }; return COMMON; });
    return commonLoading;
  }

  function byId(id) {
    return load().then(function (db) {
      for (var i = 0; i < db.foods.length; i++) {
        if (db.foods[i].id === id) return db.foods[i];
      }
      return null;
    });
  }

  function groupName(g) {
    return (DB && DB.groups && DB.groups[g]) || '';
  }

  /* ---- 栄養素の取り出し: 100gあたり -> 指定グラムへ換算 ---- */
  function scale(food, grams) {
    var out = {};
    var r = (grams || 0) / 100;
    for (var i = 0; i < NUTRIENT_KEYS.length; i++) {
      var k = NUTRIENT_KEYS[i];
      if (food[k] != null) out[k] = round(food[k] * r, 3);
    }
    out.sugar = sugarOf(out);
    return out;
  }

  function sugarOf(n) {
    if (n.carb == null) return null;
    return round(n.carb - (n.fiber || 0), 2);
  }

  function round(v, d) {
    var p = Math.pow(10, d == null ? 1 : d);
    return Math.round(v * p) / p;
  }

  /* ---- 合算 ---- */
  function sum(list) {
    var out = {};
    (list || []).forEach(function (n) {
      if (!n) return;
      for (var k in n) {
        if (typeof n[k] !== 'number') continue;
        out[k] = (out[k] || 0) + n[k];
      }
    });
    for (var k2 in out) out[k2] = round(out[k2], 2);
    return out;
  }

  /* ---- 「食材」(普段の呼び名 + よみ + 1食分の目安) ---- */
  function commonIndex() {
    return loadCommon().then(function (data) {
      if (!data._indexed) {
        data.items.forEach(function (it) {
          it._n = norm(it.label) + ' ' + norm(it.yomi || '') + ' ' + norm(it.src || '');
        });
        data._byKey = {};
        data.items.forEach(function (it) { data._byKey[it.key] = it; });
        data._indexed = true;
      }
      return data;
    });
  }

  /* 「とりむね」「なす」のような普段の呼び名・よみで引く。
     成分表そのものは「＜鳥肉類＞ にわとり…」なので、こちらを先に当てる。 */
  function searchCommon(query, opts) {
    opts = opts || {};
    var raw = String(query || '').trim();
    if (!raw) return Promise.resolve([]);
    var q = norm(raw);
    return commonIndex().then(function (data) {
      var hits = [];
      data.items.forEach(function (it) {
        var pos = it._n.indexOf(q);
        if (pos === -1) return;
        // 表示名の先頭で一致したものを上に
        var sc = (norm(it.label).indexOf(q) === 0) ? 100
          : (norm(it.yomi || '').indexOf(q) === 0 ? 90 : (pos === 0 ? 70 : 40));
        hits.push({ it: it, sc: sc });
      });
      hits.sort(function (a, b) {
        if (b.sc !== a.sc) return b.sc - a.sc;
        return a.it.label.length - b.it.label.length;
      });
      return hits.slice(0, opts.limit || 24).map(function (h) { return h.it; });
    });
  }

  function commonById(key) {
    return commonIndex().then(function (data) { return data._byKey[key] || null; });
  }

  function meta(key) { return NUTRIENT_META[key] || [key, '']; }

  global.Foods = {
    load: load, loadCommon: loadCommon, search: search, byId: byId, scale: scale, sum: sum,
    searchCommon: searchCommon, commonById: commonById,
    groupName: groupName, meta: meta, norm: norm, round: round, sugarOf: sugarOf,
    KEYS: NUTRIENT_KEYS, META: NUTRIENT_META,
    ready: function () { return !!DB; },
    count: function () { return DB ? DB.foods.length : 0; },
    source: function () { return DB ? DB.source : ''; }
  };
})(window);
