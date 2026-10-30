/* estimate.js - 食品名と既知の栄養値から、欠けている栄養素だけを成分表で補う */
(function (global) {
  'use strict';

  var F = global.Foods;
  var MODEL = null, loading = null;
  var MACROS = ['protein', 'fat', 'carb'];
  var CONF_RANK = { high: 1, mid: 2, low: 3 };

  function finite(v) { return typeof v === 'number' && isFinite(v); }
  function round(v) { return Math.round(v * 1000) / 1000; }

  function median(values) {
    values = values.filter(finite).sort(function (a, b) { return a - b; });
    if (!values.length) return null;
    var m = Math.floor(values.length / 2);
    return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
  }

  function loadProfiles() {
    return fetch('data/estimate-profiles.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function load() {
    if (MODEL) return Promise.resolve(MODEL);
    if (loading) return loading;
    loading = Promise.all([F.load(), F.loadCategories(), loadProfiles(), F.loadYomi()]).then(function (r) {
      var db = r[0], cats = r[1] || {}, profiles = r[2] || {};
      var byId = {};
      (db.foods || []).forEach(function (food) {
        byId[food.id] = food;
      });

      var rules = (cats.rules || []).map(function (rule) {
        var copy = {};
        for (var k in rule) copy[k] = rule[k];
        copy._kw = (rule.kw || []).map(F.norm).filter(Boolean);
        copy._not = (rule.not || []).map(F.norm).filter(Boolean);
        return copy;
      });

      MODEL = {
        byId: byId,
        rules: rules,
        excludes: (cats.excludes || []).map(F.norm).filter(Boolean)
      };
      buildSimilar(MODEL, db.foods || [], profiles);
      return MODEL;
    }).then(function (model) {
      var S = global.Store;
      if (!S || !S.Anchors || ANCHORS) return model;
      return S.Anchors.get().then(function (map) { if (!ANCHORS) setAnchors(map); return model; },
        function () { return model; });
    }).catch(function (e) { loading = null; throw e; });
    return loading;
  }

  function supplement(name, model) {
    var n = F.norm(name);
    if (/さぷり|かぷせる|たぶれっと|ちゅあぶる|びたみん剤|栄養補助食品|医薬品|ぷろていん|かりうむのめぐり/.test(n)) return true;
    if (/1日(?:分)?[0-9]*粒/.test(n) || /[0-9]錠/.test(n)) return true;
    return model.excludes.some(function (x) { return n.indexOf(x) !== -1; });
  }

  /* hint=true のときは、生の食品だけに使う規則(rawOnly)を調理済みの名前でも返す。
     量は決めず、似た食品の手がかり(どの食品か)にだけ使う(v58)。
     「まろやかな味わい若どりレバー焼」は「焼」で鶏レバーの規則が外れ、名前の手がかりも失って、
     炭水化物まで分かっている記録(たれの糖分あり)で 牛レバー(ビタミンAが鶏の約15分の1)を選んでいた */
  function matchingRule(name, model, hint) {
    var n = F.norm(name);
    for (var i = 0; i < model.rules.length; i++) {
      var rule = model.rules[i];
      if (rule._not.some(function (x) { return n.indexOf(x) !== -1; })) continue;
      if (rule._kw.some(function (x) { return n.indexOf(x) !== -1; })) {
        if (rule.rawOnly && !hint) {
          var remainder = n;
          rule._kw.forEach(function (kw) { remainder = remainder.replace(kw, ''); });
          if (/焼|やき|茹|ゆで|蒸|煮|炒|いため|揚|あげ|乾燥|干し|缶詰/.test(remainder)) return null;
        }
        // 食材名が料理の一部に現れただけでは、その食材一つで料理全体を補わない。
        if (rule.singleFood && /弁当|定食|丼|どんぶり|ばーがー|さんど|すーぷ|しちゅー|かれー|ぴざ|ぐらたん|炒飯|ちゃーはん|炊き込み|炊込|和え|あえ|炒め|いため|煮込み|煮込|さらだ|菓子|くっきー|けーき|味付|風味|ふれーばー|味$/.test(n)) return null;
        return rule;
      }
    }
    return null;
  }

  /* kcal と g をそのまま二乗すると kcal だけで重量が決まる。
     各成分の倍率の中央値で量を推定し、既知の全項目と照合する(v54)。 */
  function fitsReference(known, ref, factor) {
    return ['kcal'].concat(MACROS).every(function (k) {
      if (!finite(known[k]) || !finite(ref[k])) return true;
      var predicted = ref[k] * factor;
      var tolerance = k === 'kcal' ? Math.max(20, known[k] * 0.3) : Math.max(1, known[k] * 0.4);
      return Math.abs(predicted - known[k]) <= tolerance;
    });
  }

  function fitGrams(known, ref) {
    var keys = ['kcal'].concat(MACROS), ratios = [];
    keys.forEach(function (k) {
      if (!finite(known[k]) || !finite(ref[k])) return;
      if (ref[k] <= 0 || (k !== 'kcal' && ref[k] < 1)) return;
      ratios.push(known[k] / ref[k]);
    });
    if (!ratios.length) return null;
    var grams = median(ratios) * 100;
    if (!finite(grams) || grams < 1 || grams > 1500) return null;
    return fitsReference(known, ref, grams / 100) ? grams : null;
  }

  function copyKnown(known) {
    var out = {};
    for (var k in (known || {})) if (finite(known[k])) out[k] = known[k];
    return out;
  }

  function addFromFood(out, ref, grams, added) {
    F.KEYS.forEach(function (k) {
      if (k === 'kcal' || finite(out[k]) || !finite(ref[k])) return;
      out[k] = round(ref[k] * grams / 100);
      added.push(k);
    });
  }

  function ruleGrams(rule, opts) {
    opts = opts || {};
    var amount = Number(opts.amount);
    if (!finite(amount) || amount <= 0) return null;
    if (opts.unit === 'g') return amount;
    if (opts.unit === '100g') return amount * 100;
    if (finite(rule.grams) && rule.grams > 0 && opts.unit !== 'ml' && opts.unit !== 'mL') return rule.grams * amount;
    return null;
  }

  /* 生の果物のように、名前で食品そのものが決まり成分もほぼ一定のもの(規則に byKcal)は、
     カロリーから重さを逆算してよい。あすけんから移した記録はカロリーしか持たず、
     ゼスプリ サンゴールドもバナナもビタミンCが空のままだった(2026-10-02 利用者報告)。
     容量の書いてある名前(350ml など)は飲み物なので使わない。果汁入りのお酒やジュースを
     生の果物の重さに換算すると、ビタミンCなどが何倍にもつく */
  function kcalGrams(rule, known, ref, name) {
    if (!rule || !rule.byKcal || !ref || !finite(known.kcal) || known.kcal <= 0) return null;
    if (!finite(ref.kcal) || ref.kcal <= 0) return null;
    if (/[0-9](?:ml|l|ℓ)(?![a-z])/.test(F.norm(name))) return null;
    var grams = known.kcal * 100 / ref.kcal;
    return (grams >= 1 && grams <= 1500) ? grams : null;
  }

  // 主食を含む料理は単一食材へ置き換えず、成分表の複数食材モデルで補う。
  function recipeNutrients(rule, model) {
    if (!Array.isArray(rule.recipe) || !rule.recipe.length) return null;
    var total = {}, refs = [];
    rule.recipe.forEach(function (part) {
      var food = model.byId[String(part.ref || '')], grams = Number(part.grams);
      if (!food || !finite(grams) || grams <= 0) return;
      refs.push(String(part.ref));
      F.KEYS.forEach(function (key) {
        if (!finite(food[key])) return;
        total[key] = (total[key] || 0) + food[key] * grams / 100;
      });
    });
    return refs.length ? { nutrients: total, refs: refs } : null;
  }

  function addFromRecipe(out, recipe, scale, added) {
    F.KEYS.forEach(function (key) {
      if (key === 'kcal' || finite(out[key]) || !finite(recipe[key])) return;
      out[key] = round(recipe[key] * scale);
      added.push(key);
    });
  }

  function mergeEst(oldEst, added, info) {
    var keys = [];
    ((oldEst && oldEst.keys) || []).concat(added).forEach(function (k) {
      if (keys.indexOf(k) === -1) keys.push(k);
    });
    var oldConf = oldEst && oldEst.conf;
    var conf = oldConf && CONF_RANK[oldConf] > CONF_RANK[info.conf] ? oldConf : info.conf;
    return {
      keys: keys,
      conf: conf,
      ref: info.ref || (oldEst && oldEst.ref) || '',
      cat: info.cat || (oldEst && oldEst.cat) || '',
      method: info.method || (oldEst && oldEst.method) || '',
      v: 3
    };
  }

  function finish(out, original, added, info, oldEst) {
    if (!finite(out.sugar) && finite(out.carb) && finite(out.fiber)) {
      var sugarWasEstimated = added.indexOf('carb') !== -1 || added.indexOf('fiber') !== -1;
      out.sugar = F.sugarOf(out);
      if (sugarWasEstimated && added.indexOf('sugar') === -1) added.push('sugar');
    } else if (finite(original.sugar)) {
      out.sugar = original.sugar;
    }
    if (!added.length) return null;
    return { nutrients: out, est: mergeEst(oldEst, added, info) };
  }

  /*
     戻り値: {nutrients, est}。実測値は一切上書きせず、欠損だけを補う。
     kcal が無い食品とサプリメントは null のままにする。
  */
  /* 果物(byKcal)の記録が、その果物の成分表以外から推定した値を持っているか。
     v33より前の「記録に栄養素を補う」は、カロリーしか無い食品にも全食品の中央値を当てていた。
     ゼスプリ サンゴールドの P2.72 F0.79 C7.9 は全食品中央値×54kcalと小数点以下まで一致し、
     ビタミンCは0.077mgだった(2026-10-02 実機)。手で成分表の食品を紐づけた推定は残す */
  function staleFruitEstimate(est, rule) {
    return !!(rule && rule.byKcal && est && est.keys && est.keys.length &&
      est.method !== 'manual-reference' && String(est.ref || '') !== String(rule.ref || ''));
  }

  /* ================= 似た食品から補う(v55) =================
     v54では、対応表(rules)で決まらない食品は値を不明のままにした。外食・商品の多くは
     カロリー・PFC・塩分しか公表されていないため、ビタミン・ミネラルが不明の食品が増え、
     採点できない日がほとんどになった(2026-10-30 利用者報告)。利用者の指示
     「推計できない部分はゼロではなく、似ている食材・メニューから限りなく近い値を当てはめる」により、
     対応表で決まらない食品も次の順で必ず補う(推定の印を付ける。実測・手入力は上書きしない)。
       ① PFCが分からない食品は、料理名が同じ外食・商品の公表値の割合(estimate-profiles.json)か、
          名前の合う成分表の食品の割合で、たんぱく質・脂質・炭水化物・塩分を補う
       ② 食品名の語(成分表の食品名とその読み、料理の見本)が重なる食品を探し、
          PFCのエネルギー比が合うように組み合わせて、その割合でビタミン・ミネラルなどを補う
          (唐揚げ弁当 = とりから揚げ と ごはん を PFC が合う割合で混ぜる、など)
       ③ 名前で見つからなければ、名前から分かる食品群(菓子・飲み物・料理…)の中で
          PFCの割合が近い食品を組み合わせる
     値は「カロリーあたりの量」をそのカロリーに当てはめる */

  // 普段の呼び方 → 成分表の語。名前に左の語があれば右の語も含むものとして探す。長い語を先に当てる
  var SYNONYMS = {
    'チキン': 'にわとり', '鶏': 'にわとり', '鳥肉': 'にわとり', 'とり肉': 'にわとり', '若鶏': 'にわとり 若どり',
    '胸肉': 'むね', 'むね肉': 'むね', 'もも肉': 'もも', 'ササミ': 'ささみ', '手羽': '手羽',
    '豚こま': 'ぶた かた 脂身つき', '豚小間': 'ぶた かた 脂身つき', '豚バラ': 'ぶた ばら 脂身つき',
    '豚ロース': 'ぶた ロース 脂身つき', '豚ひき': 'ぶた ひき肉', '鶏ひき': 'にわとり ひき肉', '合挽': 'ひき肉',
    '合いびき': 'ひき肉', '牛こま': 'うし かた 脂身つき', 'サラダチキン': 'にわとり むね 皮なし',
    'ポーク': 'ぶた', '豚': 'ぶた', 'ビーフ': 'うし', '牛': 'うし', '和牛': 'うし 和牛肉',
    'カルビ': 'うし ばら', 'ハラミ': 'うし 横隔膜', '牛タン': 'うし 舌', 'タン塩': 'うし 舌', 'レバー': '肝臓',
    'ラム': 'めんよう', 'マトン': 'めんよう', 'ウインナー': 'ウインナーソーセージ', 'ナゲット': 'チキンナゲット',
    '唐揚げ': 'とりから揚げ から揚げ', '唐揚': 'とりから揚げ から揚げ', 'からあげ': 'とりから揚げ から揚げ',
    'から揚げ': 'とりから揚げ から揚げ', 'から揚': 'とりから揚げ から揚げ', '竜田揚げ': 'から揚げ', '竜田': 'から揚げ',
    'フライドチキン': 'にわとり から揚げ', 'キットカット': 'チョコレート ウエハース', 'カントリーマアム': 'ソフトビスケット',
    '鮭': 'さけ しろさけ', 'サーモン': 'さけ たいせいようさけ', 'シャケ': 'さけ しろさけ', 'しゃけ': 'さけ しろさけ',
    '鯖': 'まさば', 'サバ': 'まさば', 'さば': 'まさば', '鯵': 'まあじ', 'アジ': 'まあじ', 'あじ': 'まあじ',
    'マグロ': 'まぐろ', '鮪': 'まぐろ', 'ツナ': 'まぐろ 缶詰', 'ネギトロ': 'まぐろ 脂身',
    'カツオ': 'かつお', '鰹': 'かつお', 'イカ': 'いか', 'スイカ': 'すいか', '西瓜': 'すいか', 'タコ': 'たこ',
    'エビ': 'えび', '海老': 'えび',
    'カニ': 'かに', '蟹': 'かに', 'ホタテ': 'ほたてがい', '帆立': 'ほたてがい', 'アサリ': 'あさり',
    'しらす': 'しらす干し', '明太': 'からしめんたいこ', '鰤': 'ぶり', 'ブリ': 'ぶり', 'ウナギ': 'うなぎ かば焼',
    '鰻': 'うなぎ かば焼', '秋刀魚': 'さんま', 'サンマ': 'さんま', '鰯': 'いわし', 'イワシ': 'いわし', 'タラ': 'まだら', '鱈': 'まだら',
    '卵': '鶏卵 全卵', '玉子': '鶏卵 全卵', 'たまご': '鶏卵 全卵', 'エッグ': '鶏卵 全卵', '目玉焼き': '鶏卵 全卵 目玉焼き',
    'ゆで卵': '鶏卵 全卵 ゆで', 'ゆで玉子': '鶏卵 全卵 ゆで', '卵焼き': 'たまご焼', '玉子焼き': 'たまご焼', 'だし巻': 'だし巻きたまご',
    'ご飯': 'めし 精白米 うるち米 水稲めし', 'ごはん': 'めし 精白米 うるち米 水稲めし', 'ライス': 'めし 精白米 うるち米 水稲めし',
    '白米': 'めし 精白米 うるち米 水稲めし', '白飯': 'めし 精白米 うるち米 水稲めし', '丼': 'めし 精白米 うるち米',
    '弁当': 'めし 精白米 うるち米', '定食': 'めし 精白米 うるち米 味噌汁', 'おむすび': 'おにぎり', 'おにぎり': 'おにぎり',
    'お粥': '全かゆ', 'おかゆ': '全かゆ', '雑炊': '全かゆ', '胡麻': 'ごま', 'ゴマ': 'ごま', '和え': '和え物',
    '食パン': '角形食パン', 'トースト': '角形食パン 焼き', 'パン': 'パン類', 'パンケーキ': 'ホットケーキ',
    'パンプキン': 'かぼちゃ', 'パイナップル': 'パインアップル', '中華麺': '中華めん', '中華そば': '中華めん',
    '焼きそば': '蒸し中華めん', '焼そば': '蒸し中華めん', 'マカロニ': 'マカロニ・スパゲッティ',
    'カップ麺': '即席カップめん', 'カップラーメン': '中華スタイル即席カップめん', 'カップヌードル': '中華スタイル即席カップめん',
    'インスタントラーメン': '即席中華めん', '袋麺': '即席中華めん',
    '餃子': 'ぎょうざ', 'ギョーザ': 'ぎょうざ', '焼売': 'しゅうまい', 'シュウマイ': 'しゅうまい', 'シューマイ': 'しゅうまい',
    '春巻': '春巻き', '炒飯': 'チャーハン', '海老フライ': 'えびフライ', 'カキフライ': 'かきフライ', 'メンチ': 'メンチカツ',
    'ハンバーグ': '合いびきハンバーグ', 'コロッケ': 'ポテトコロッケ', 'シチュー': 'ビーフシチュー',
    'グラタン': 'えびグラタン', 'ピラフ': 'えびピラフ', 'トンカツ': 'とんかつ', 'ロースカツ': 'ロース とんかつ', 'ヒレカツ': 'ヒレ とんかつ', 'カツ': 'とんかつ',
    '玉子とうふ': 'たまご豆腐', '玉子豆腐': 'たまご豆腐', '卵豆腐': 'たまご豆腐', '蒸し鶏': 'にわとり むね 皮なし',
    '豚汁': 'とん汁', 'きんぴら': 'きんぴらごぼう', 'ひじき': 'ひじきのいため煮', 'スカッシュ': '炭酸飲料',
    '切干大根': '切り干し大根の煮物 切干しだいこん', '切り干し大根': '切り干し大根の煮物 切干しだいこん',
    '豆腐': '豆腐 木綿豆腐', 'とうふ': '豆腐 木綿豆腐', '冷奴': '絹ごし豆腐', '冷や奴': '絹ごし豆腐', '厚揚げ': '生揚げ',
    '納豆': '糸引き納豆', 'がんも': 'がんもどき',
    '牛乳': '普通牛乳', 'ミルク': '普通牛乳', 'ミルクティー': '紅茶 浸出液 普通牛乳', 'ミルクチョコ': 'ミルクチョコレート',
    'チーズ': 'チーズ プロセスチーズ', '生クリーム': 'クリーム', 'ホイップ': 'ホイップクリーム',
    'アイス': 'アイスクリーム ラクトアイス', 'ソフトクリーム': 'ソフトクリーム', 'プリン': 'カスタードプリン',
    'チョコ': 'チョコレート ミルクチョコレート', 'クッキー': 'ビスケット ソフトビスケット', '煎餅': 'せんべい', 'ポテチ': 'ポテトチップス',
    'ドーナツ': 'ドーナッツ', 'ポテトチップス': 'ポテトチップス', 'ポテトチップ': 'ポテトチップス',
    'ピュアポテト': 'ポテトチップス', 'プライドポテト': 'ポテトチップス', 'じゃがりこ': 'ポテトチップス', 'ポテコ': '成形ポテトチップス',
    '柿の種': 'あられ 米菓', 'ばかうけ': '米菓 揚げせんべい', 'おかき': 'あられ 米菓', 'あられ': 'あられ 米菓',
    'スーパーカップ': 'ラクトアイス', 'コーンスナック': 'コーンスナック',
    'そば': 'そば', 'もち': 'もち', 'のり': 'のり', 'みそ': 'みそ', 'えび': 'えび', 'かに': 'かに', 'たこ': 'たこ', 'どら焼き': 'どら焼', '大福': '大福もち', '団子': 'だんご', '饅頭': 'まんじゅう', '羊羹': 'ようかん',
    'コーヒー': 'コーヒー 浸出液', '珈琲': 'コーヒー 浸出液', 'ブラックコーヒー': 'コーヒー 浸出液', '缶コーヒー': 'コーヒー飲料',
    '紅茶': '紅茶 浸出液', 'アイスティー': '紅茶 浸出液', 'レモンティー': '紅茶 浸出液', 'ストレートティー': '紅茶 浸出液',
    '緑茶': 'せん茶 浸出液', 'お茶': 'せん茶 浸出液',
    '烏龍茶': 'ウーロン茶 浸出液', 'ウーロン茶': 'ウーロン茶 浸出液', 'ほうじ茶': 'ほうじ茶 浸出液', '麦茶': '麦茶 浸出液',
    'オレンジジュース': 'バレンシア ジュース', 'ジュース': '果実飲料 ジュース', 'ビール': 'ビール 淡色', 'ワイン': 'ぶどう酒', '赤ワイン': 'ぶどう酒 赤',
    '白ワイン': 'ぶどう酒 白', '日本酒': '清酒', 'ハイボール': 'ウイスキー', '焼酎': 'しょうちゅう',
    'チューハイ': '缶チューハイ', '酎ハイ': '缶チューハイ', 'サワー': '缶チューハイ',
    'みかん': 'うんしゅうみかん', '蜜柑': 'うんしゅうみかん', 'キウイ': 'キウイフルーツ', 'トマト': '赤色トマト',
    'ほうれん草': 'ほうれんそう', '小松菜': 'こまつな', 'もやし': 'りょくとうもやし', '玉ねぎ': 'たまねぎ', '人参': 'にんじん',
    'ポテト': 'じゃがいも', '大根': 'だいこん', 'しいたけ': 'しいたけ', 'えのき': 'えのきたけ', 'しめじ': 'ぶなしめじ',
    '海苔': 'のり', 'ピーナッツ': 'らっかせい', '落花生': 'らっかせい', 'オリーブオイル': 'オリーブ油',
    'ケチャップ': 'トマトケチャップ', '醤油': 'しょうゆ', '味噌': 'みそ', '砂糖': '上白糖', '蜂蜜': 'はちみつ'
  };
  // 飲み物の「アイス」は氷菓ではない(アイスコーヒー・アイスカフェラテ…)
  var ICED = /あいす(?=こ|か|て|ら|ま|ほ|み|ここ|ちゃ|ぐりん|うろん|れもん)/g;

  // 名前から分かる食品群(名前で似た食品が見つからないときの絞り込み)
  var SWEETS_HINT =
    // 短い語は別の語の一部に当たる(シュー→オレンジスカッシュ、グミ→メグミルク、パイ→パイナップル)ので入れない
    [['ケーキ', 'チョコ', 'クッキー', 'ビスケット', 'せんべい', '煎餅', 'スナック', 'ポテチ', 'アイス', 'プリン', 'ゼリー',
      'グミキャンディ', 'キャンディ', '飴', 'ドーナツ', 'アップルパイ', 'タルト', 'まんじゅう', '饅頭', '大福', '羊羹', 'ようかん',
      '団子', 'だんご', 'もなか', '最中', 'カステラ', 'マフィン', 'スコーン', 'ワッフル', 'クレープ', 'パフェ', 'シュークリーム',
      'エクレア', 'バウム', 'マドレーヌ', 'ラムネ', '菓子', 'おかき', 'あられ', 'かりんとう', 'どら焼', 'わらび'],
     ['15', '13']];
  var GROUP_HINTS = [
    SWEETS_HINT,
    [['丼', '定食', '弁当', 'カレー', 'ラーメン', 'うどん', 'そば', 'パスタ', 'ピザ', 'バーガー', 'サンド', '寿司', '炒飯',
      'グラタン', 'ドリア', 'シチュー', 'スープ', '汁', '鍋', 'サラダ', '炒め', '煮', '焼', '揚', 'フライ', 'カツ', '天ぷら',
      'セット', 'プレート', 'ランチ', 'ディナー', 'コース', 'フォカッチャ', 'ドッグ', 'ナゲット', 'チキン', 'パック'],
     ['18', '01', '11', '10', '06', '12', '04', 'dish']],
    [['コーヒー', '珈琲', 'ラテ', 'カフェ', 'ティー', '紅茶', 'お茶', '緑茶', '麦茶', '烏龍茶', 'ウーロン茶', 'ほうじ茶',
      'ジャスミン茶', 'ジュース', 'ドリンク', 'ソーダ', 'サイダー', 'コーラ', 'ビール', '日本酒', '梅酒', 'ワイン', 'ハイボール',
      'チューハイ', '酎ハイ', 'サワー', '焼酎', 'ウイスキー', 'スムージー',
      'フラペチーノ', 'シェイク', 'ココア', '飲料', 'ドリンク'],
     ['16', '13', '07']],
    [['ヨーグルト', 'チーズ', '牛乳', 'ミルク'], ['13']],
    [['パン', 'ベーグル', 'トースト'], ['01', '15']],
    [['肉'], ['11']], [['魚'], ['10']], [['野菜'], ['06']], [['果物', 'フルーツ'], ['07']]
  ];

  // 組み合わせの料理を表す語(PFCが分からないとき、外食の同じ料理名の割合を主に使う)
  var DISH_WORDS = ['丼', '定食', '弁当', 'セット', 'カレー', 'ラーメン', 'うどん', 'そば', 'パスタ', 'スパゲッティ', 'ピザ',
    'バーガー', 'サンド', '寿司', 'すし', '炒飯', 'チャーハン', 'グラタン', 'ドリア', 'シチュー', 'スープ', '汁', '鍋', 'サラダ',
    'プレート', 'ランチ', 'パック', 'フォカッチャ', 'ドッグ', '麺', '御膳', 'ボックス', 'BOX', '盛り合わせ', '盛合せ'];

  // 飲み物の名前。生の果物・野菜など、飲み物でない食品を似た食品に選びにくくする(メロンソーダ ≠ メロン)
  var DRINK_WORDS = ['ジュース', 'ドリンク', 'ソーダ', 'サイダー', 'コーラ', 'スムージー', 'シェイク', 'シェーク', 'ラテ',
    'ティー', 'コーヒー', '珈琲', 'お茶', '緑茶', '紅茶', '烏龍茶', 'ウーロン茶', '麦茶', 'ほうじ茶', 'サワー', 'ハイボール',
    'ビール', 'ワイン', '日本酒', '焼酎', 'チューハイ', 'カフェオレ', 'ネクター', 'エード', 'フロート', 'フラペチーノ', 'スカッシュ',
    'ココア', '牛乳', '豆乳', '飲料', '飲む'];
  var DRINK_TOKENS = ['ジュース', '飲料', '浸出液', '乳飲料', '牛乳', '豆乳', '酒', 'ビール', 'ワイン', 'ぶどう酒', 'コーヒー',
    'ココア', '茶', 'サイダー', 'コーラ', 'ネクター', 'スポーツドリンク', 'チューハイ', 'ウイスキー', 'しょうちゅう', '乳酸菌',
    'ヨーグルト', 'ミルク', 'クリーム', 'ラテ', 'フラペチーノ', 'ミルクティー'];

  // 成分表の名前の語のうち、調理の状態を表すもの(名前の照合には使わず、状態の一致に使う)
  var STATES = {
    '生': 'raw', 'ゆで': 'boil', '水煮': 'boil', '焼き': 'grill', '乾': 'dry', '素干し': 'dry', '油いため': 'stir',
    'ソテー': 'stir', '蒸し': 'steam', '素揚げ': 'fry', '揚げ': 'fry', '天ぷら': 'fry', 'フライ': 'fry', 'から揚げ': 'fry',
    '電子レンジ調理': 'steam', '冷凍': 'frozen'
  };
  var RECORD_STATES = [
    ['fry', ['揚', 'あげ', 'フライ', '天ぷら', 'カツ', 'かつ']], ['grill', ['焼', 'やき', 'グリル', 'ロースト', 'ソテー', 'ステーキ']],
    ['stir', ['炒', 'いため']], ['boil', ['茹', 'ゆで', 'ボイル', '煮']], ['steam', ['蒸', 'むし']],
    ['raw', ['刺身', '刺し身', 'たたき', 'カルパッチョ', 'ユッケ']], ['dry', ['干し', '干物', 'ドライ']]
  ];
  // 区分だけを表す語・どこにでも付く語は軽く扱う
  var LIGHT = ['その他', '主品目', '副品目', '加工品', '市販品', '皮なし', '皮つき', '脂身つき', '脂身', '赤肉', '皮下脂肪なし',
    '養殖', '天然', '全粒', '果実', '根', '葉', '茎', '茎葉', '結球葉', '塊茎', 'りん茎', '砂じょう', '果皮', '若どり', '成鶏',
    '親', '大型種肉', '中型種肉', '乳用肥育牛肉', '和牛肉', '輸入牛肉', '交雑牛肉', '子牛肉', '普通', '国産', '輸入'];

  function sharesOf(n) {
    if (!finite(n.kcal) || n.kcal <= 0) return null;
    if (!MACROS.every(function (k) { return finite(n[k]); })) return null;
    return [n.protein * 4 / n.kcal, n.fat * 9 / n.kcal, n.carb * 4 / n.kcal];
  }

  function buildSimilar(model, foods, profiles) {
    var light = {}, states = {};
    LIGHT.forEach(function (t) { light[F.norm(t)] = 1; });
    Object.keys(STATES).forEach(function (t) { states[F.norm(t)] = STATES[t]; });
    var items = [], df = {};

    function addItem(id, group, display, words, nut, alt) {
      if (!finite(nut.kcal) || nut.kcal < 1) return;
      var per = {};
      F.KEYS.forEach(function (k) { if (k !== 'kcal' && finite(nut[k])) per[k] = nut[k] / nut.kcal; });
      var toks = [], state = '';
      words.forEach(function (w) {
        var t = F.norm(w.t).replace(/類$/, '');
        // 1文字の語(皮・葉・根・肉…)は、名前の「皮なし」などにも当たって取り違えるので使わない
        if (!t || t.length < 2 || /^[0-9.%]+$/.test(t)) return;
        if (states[t]) { state = state || states[t]; return; }
        if (toks.some(function (x) { return x.t === t; })) return;
        toks.push({ t: t, cat: !!w.cat, light: !!light[t] });
      });
      if (!toks.length) return;
      toks.forEach(function (x) { df[x.t] = (df[x.t] || 0) + 1; });
      items.push({ id: id, g: group, n: display, toks: toks, state: state, per: per, sh: sharesOf(nut), d: nut.kcal, alt: !!alt });
    }

    foods.forEach(function (food) {
      // 「＜畜肉類＞ ぶた ［大型種肉］ ロース 脂身つき 焼き」→ 区分の語(＜＞（）)と、それ以外の語
      var words = [];
      String(food.n).replace(/[＜（(]([^＞）)]*)[＞）)]|［([^］]*)］|([^\s　＜＞（）()［］]+)/g, function (m, cat, sub, plain) {
        String(cat || sub || plain || '').split(/[・\s　]+/).forEach(function (t) {
          if (t) words.push({ t: t, cat: !!cat });
        });
        return m;
      });
      addItem(food.id, food.g, food.n, words, food);
    });
    (profiles.dishes || []).forEach(function (d) {
      var words = (d.kw || []).map(function (w) { return { t: w }; });
      addItem('dish:' + d.n, 'dish', d.n, words, d.nut || {}, true);
    });

    var N = items.length, index = {};
    items.forEach(function (it, i) {
      var total = 0;
      it.toks.forEach(function (x) {
        var w = Math.log(1 + N / df[x.t]);
        if (x.cat) w *= 0.5;
        if (x.light) w *= 0.3;
        x.w = w;
        // 料理の見本の語は言い換えなので、重みは一番重い語の分だけ数える
        total = it.alt ? Math.max(total, w) : total + w;
        (index[x.t] = index[x.t] || []).push(i);
      });
      it.total = total;
    });

    var synonyms = Object.keys(SYNONYMS).map(function (k) {
      return { k: F.norm(k), v: SYNONYMS[k].split(' ').map(F.norm).filter(Boolean) };
    }).filter(function (s) { return s.k; }).sort(function (a, b) { return b.k.length - a.k.length; });
    var hints = GROUP_HINTS.map(function (h) {
      return { words: h[0].map(F.norm).filter(Boolean), groups: h[1] };
    });
    var recordStates = RECORD_STATES.map(function (s) { return { state: s[0], words: s[1].map(F.norm) }; });
    var drinkWords = DRINK_WORDS.map(F.norm), drinkTokens = DRINK_TOKENS.map(F.norm), dishWords = DISH_WORDS.map(F.norm);
    items.forEach(function (it) {
      it.drink = it.g === '16' || it.toks.some(function (x) {
        return drinkTokens.some(function (d) { return x.t.indexOf(d) !== -1; });
      });
    });

    // 最後の手段: 全食品の「カロリーあたりの量」の中央値
    var medians = {};
    F.KEYS.forEach(function (k) {
      if (k === 'kcal') return;
      medians[k] = median(items.filter(function (it) { return it.g !== 'dish'; }).map(function (it) { return it.per[k]; }));
    });

    var firstChar = {}, bigrams = {};
    Object.keys(index).forEach(function (t) {
      (firstChar[t.charAt(0)] = firstChar[t.charAt(0)] || []).push(t);
      var seen = {};
      for (var b = 0; b + 2 <= t.length; b++) {
        var bg = t.substr(b, 2);
        if (seen[bg]) continue;
        seen[bg] = 1;
        (bigrams[bg] = bigrams[bg] || []).push(t);
      }
    });
    var profileWords = Object.keys((profiles && profiles.words) || {}).sort(function (a, b) { return b.length - a.length; });
    model.sim = {
      items: items, index: index, firstChar: firstChar, bigrams: bigrams, synonyms: synonyms, hints: hints,
      recordStates: recordStates, drinkWords: drinkWords, dishWords: dishWords, medians: medians, cache: {},
      profiles: profiles && profiles.words ? profiles.words : {}, profileAll: profiles && profiles.all,
      profileWords: profileWords
    };
  }

  // 「商品名(1個17.5g)(メーカー)」→ 最後のメーカー名と数量を外した名前
  function coreName(name) {
    var s = String(name || '');
    /* 味の名前(青のりしょうゆ味・チーズ風味)は材料ではない。空白や括弧で区切られた部分のうち
       味を表す部分を外す(全部が味の名前なら外さない) */
    var segs = s.split(/[\s　（）()「」『』]+/).filter(Boolean);
    var flavor = segs.filter(function (g) { return /(?:味|風味|フレーバー|味付け?)$/.test(g) && g.length > 1; });
    if (flavor.length && flavor.length < segs.length) {
      flavor.forEach(function (g) { s = s.replace(g, ' '); });
    }
    s = s.replace(/[（(][^（）()]*[）)]\s*$/, function (m) {
      return /[0-9０-９]/.test(m) ? m : '';
    });
    s = s.replace(/[0-9０-９.,．]+\s*(?:kcal|ｋｃａｌ|g|ｇ|ml|ｍｌ|mL|l|L|個|枚|本|杯|切れ|切|貫|粒|袋|缶|パック|人前|食|皿|玉|尾|膳|片|cm|%|％)/g, ' ');
    return F.norm(s);
  }

  // a と b の最も長い共通部分の長さ
  function commonRun(a, b) {
    var best = 0, prev = new Array(b.length + 1).fill(0);
    for (var i = 1; i <= a.length; i++) {
      var cur = new Array(b.length + 1).fill(0);
      for (var j = 1; j <= b.length; j++) {
        if (a.charAt(i - 1) === b.charAt(j - 1)) {
          cur[j] = prev[j - 1] + 1;
          if (cur[j] > best) best = cur[j];
        }
      }
      prev = cur;
    }
    return best;
  }

  /* 名前 n の中に、かなの語 t が漢字を読み下して現れるか。漢字1字は2文字以上の読みを丸ごと受け持つ
     (「冷凍日清」を とう・び・し と読んで「とうびし」に当てない) */
  function readingMatch(n, t) {
    function from(i, j) {
      if (j >= t.length) return true;
      if (i >= n.length) return false;
      var ch = n.charAt(i);
      if (/[一-龠々]/.test(ch)) {
        var rs = F.readingsOf(ch) || [];
        for (var r = 0; r < rs.length; r++) {
          if (rs[r].length >= 2 && t.substr(j, rs[r].length) === rs[r] && from(i + 1, j + rs[r].length)) return true;
        }
        return false;
      }
      return ch === t.charAt(j) && from(i + 1, j + 1);
    }
    for (var i = 0; i < n.length; i++) {
      if (/[一-龠々]/.test(n.charAt(i)) && from(i, 0)) return true;
    }
    return false;
  }

  /* 名前に語 t がどのくらい含まれるか(0〜1)。
     丸ごと含む=1。成分表の長い語(合いびきハンバーグ)は3文字以上・半分以上が続けて一致すれば一部一致。
     かな3文字以上の語は漢字を読み下しても照合する(豚肉=ぶたにく)。2文字のかなは読みでは照合しない
     (麻辣湯の「麻」=あさ のような取り違えが起きるため。よく使う漢字は SYNONYMS で補う) */
  /* 記録の重さ(g)。量が g なら量、名前に「100gあたり」「1袋175g」「350ml」などがあればそこから。
     分からなければ null */
  function recordGrams(name, opts) {
    var amount = Number(opts && opts.amount);
    if (opts && opts.unit === 'g' && amount > 0) return amount;
    if (opts && opts.unit === '100g' && amount > 0) return amount * 100;
    var s = String(name || '').replace(/[０-９．]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); });
    if (/100\s*g\s*(?:あたり|当たり|当り)/.test(s)) return 100 * (amount > 0 ? amount : 1);
    var m = s.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:g|ｇ|ml|mL|ｍｌ)(?![a-zA-Z])/);
    if (!m) return null;
    var g = parseFloat(m[1]);
    return g > 0 ? g * (amount > 0 ? amount : 1) : null;
  }

  // 語 t が名前 nm のどこまでで当たったか(文字位置)。言い換えで足した語は、その元の語の位置
  function endOf(nm, t, extraEnd) {
    var at = nm.lastIndexOf(t);
    if (at !== -1) return at + t.length;
    var best = -1;
    Object.keys(extraEnd).forEach(function (v) {
      if (v.indexOf(t) !== -1 || t.indexOf(v) !== -1) best = Math.max(best, extraEnd[v]);
    });
    if (best !== -1) return best;
    for (var k = Math.min(t.length, nm.length); k >= 2; k--) {
      var head = nm.lastIndexOf(t.slice(0, k)), tail = nm.lastIndexOf(t.slice(t.length - k));
      if (head !== -1 || tail !== -1) return Math.max(head === -1 ? 0 : head + k, tail === -1 ? 0 : tail + k);
    }
    return nm.length / 2;
  }

  function tokenStrength(n, text, t) {
    var at = text.indexOf(t);
    if (at !== -1) {
      /* かな2文字の語は、名前の中のほかの語の一部に当たりやすい(ガスト チーズ の「すとちず」に とち、
         すいか に いか)。言い換え(SYNONYMS)で足した語に当たったときだけ丸ごと一致とし、
         名前そのものに当たっただけでは、それだけで候補にならない弱い一致にする */
      if (t.length === 2 && F.isKanaQuery(t) && ('|' + text.slice(n.length) + '|').indexOf('|' + t + '|') === -1) return 0.4;
      return 1;
    }
    if (t.length >= 5) {
      // 長い語の頭か末尾が続けて一致(合いびき+ハンバーグ、ストレート+ジュース)。途中だけの一致は使わない
      var run = commonRun(t, text);
      if (run >= 3 && run >= t.length * 0.4) {
        for (var k = run; k >= 3; k--) {
          if (text.indexOf(t.slice(0, k)) !== -1 || text.indexOf(t.slice(t.length - k)) !== -1) return k / t.length;
        }
      }
    }
    if (t.length >= 3 && F.isKanaQuery(t) && /[一-龠々]/.test(n) && readingMatch(n, t)) return 1;
    return 0;
  }

  /* 名前の合う食品の一覧(重い処理なので名前ごとに覚えておく)。
     score = 当たった語の重み × √(当たった語の重み / その食品の語の重み全体) */
  function nameInfo(name, model) {
    var sim = model.sim;
    var key = String(name || '');
    if (sim.cache[key]) return sim.cache[key];
    var n = coreName(name).replace(ICED, '');
    var extra = [], used = [], extraEnd = {};
    sim.synonyms.forEach(function (s) {
      var at = n.indexOf(s.k);
      while (at !== -1) {
        var free = true;
        for (var u = 0; u < used.length; u++) {
          if (at < used[u][1] && at + s.k.length > used[u][0]) { free = false; break; }
        }
        if (free) {
          used.push([at, at + s.k.length, s.k.length >= 4]);
          extra = extra.concat(s.v);
          s.v.forEach(function (v) { extraEnd[v] = Math.max(extraEnd[v] || 0, at + s.k.length); });
          break;
        }
        at = n.indexOf(s.k, at + 1);
      }
    });
    // サラダチキン の「サラダ」が 野菜サラダ に当たらないよう、4文字以上の言い換えに当たった部分は伏せる
    var nm = n;
    used.forEach(function (u) {
      if (u[2]) nm = nm.slice(0, u[0]) + new Array(u[1] - u[0] + 1).join('|') + nm.slice(u[1]);
    });
    var text = nm + '|' + extra.join('|');
    /* 照合する語を先に絞る(全部の語を調べると重い): 名前と2文字続けて同じ部分を持つ語、
       1文字の語、名前の漢字の読みの1文字目で始まるかなの語 */
    var check = {};
    for (var c = 0; c < text.length; c++) {
      var ch = text.charAt(c);
      (sim.bigrams[text.substr(c, 2)] || []).forEach(function (t) { check[t] = 1; });
      if (/[一-龠々]/.test(ch)) {
        (F.readingsOf(ch) || []).forEach(function (r) {
          (sim.firstChar[r.charAt(0)] || []).forEach(function (t) {
            if (t.length >= 3 && F.isKanaQuery(t)) check[t] = 1;
          });
        });
      }
    }
    var matched = {}, where = {};
    Object.keys(check).forEach(function (t) {
      var st = tokenStrength(nm, text, t);
      if (st > 0) { matched[t] = st; where[t] = endOf(nm, t, extraEnd) / Math.max(1, nm.length); }
    });
    var state = '';
    for (var s = 0; s < sim.recordStates.length && !state; s++) {
      if (sim.recordStates[s].words.some(function (w) { return n.indexOf(w) !== -1; })) state = sim.recordStates[s].state;
    }
    // 菓子の名前(コーヒーゼリー・紅茶のケーキ)は飲み物として扱わない
    var dishName = sim.dishWords.some(function (d) { return n.indexOf(d) !== -1; });
    var drink = sim.drinkWords.some(function (w) { return n.indexOf(w) !== -1; }) &&
      !sim.hints[0].words.some(function (w) { return n.indexOf(w) !== -1; });
    var scores = {};
    Object.keys(matched).forEach(function (t) {
      sim.index[t].forEach(function (i) { scores[i] = 1; });
    });
    var pool = [];
    Object.keys(scores).forEach(function (i) {
      var it = sim.items[i], hit = 0, strong = false, sig = [];
      it.toks.forEach(function (x) {
        if (!matched[x.t]) return;
        hit = it.alt ? Math.max(hit, x.w * matched[x.t]) : hit + x.w * matched[x.t];
        sig.push(x.t);
        if (!x.cat && !x.light && x.t.length >= 2 && matched[x.t] >= 0.5) strong = true;
      });
      if (!strong) return;
      var sc = hit * Math.sqrt(hit / it.total);
      /* 日本語の料理名は最後の語が本体(チーズINハンバーグ=ハンバーグ、いちごミルク=ミルク、鮭おにぎり=おにぎり)。
         名前の後ろの方で当たった食品ほど重くする */
      if (!dishName) {
        var head = 0;
        it.toks.forEach(function (x) { if (matched[x.t] && !x.cat && where[x.t] > head) head = where[x.t]; });
        sc *= 0.4 + 0.6 * head;
      }
      if (state && it.state) sc *= (state === it.state) ? 1.2 : 0.85;
      else if (!state && it.state && it.state !== 'raw') sc *= 0.95;
      if (drink && !it.drink) sc *= 0.1;
      pool.push({ it: it, s: sc, sig: sig.join('|') });
    });
    pool.sort(function (a, b) { return b.s - a.s; });
    var best = pool.length ? pool[0].s : 0;
    /* 上位の4割以上の点の候補を残す。上位の候補に無い語で当たった候補は2.5割以上で残す
       (チーズinかまぼこ で、チーズが強く当たって かまぼこ が落ちないように) */
    var seenTok = {};
    pool = pool.filter(function (p) {
      var fresh = p.sig.split('|').some(function (t) { return !seenTok[t]; });
      var keep = p.s >= best * 0.4 || (fresh && p.s >= best * 0.25);
      if (keep) p.sig.split('|').forEach(function (t) { seenTok[t] = 1; });
      return keep;
    }).slice(0, 30);
    var groups = null;
    for (var h = 0; h < sim.hints.length && !groups; h++) {
      if (sim.hints[h].words.some(function (w) { return n.indexOf(w) !== -1; })) groups = sim.hints[h].groups;
    }
    var info = { pool: pool, best: best, groups: groups, n: n, drink: drink, dish: dishName };
    sim.cache[key] = info;
    return info;
  }

  function dist(a, b) {
    var d = 0;
    for (var i = 0; i < 3; i++) d += (a[i] - b[i]) * (a[i] - b[i]);
    return Math.sqrt(d);
  }

  /* 三大栄養素の合計に占める割合どうしの差。表示のカロリーとPFCの合計が合わない食品
     (まろやかな味わい若どりレバー焼: 159kcal に対し PFC は 117kcal 分)でも、
     中身の割合が同じなら同じ食品とみなせるよう、名前で決めてよいかの判定に使う(v57) */
  function distN(a, b) {
    var sa = a[0] + a[1] + a[2], sb = b[0] + b[1] + b[2];
    if (!(sa > 0) || !(sb > 0)) return dist(a, b);
    return dist([a[0] / sa, a[1] / sa, a[2] / sa], [b[0] / sb, b[1] / sb, b[2] / sb]);
  }

  /* カロリーの割合 x(合計1)で候補を混ぜたとき、PFCのエネルギー比が target に近く、
     しかも名前の合い方で決めた割合 x0 から離れすぎないものを探す(射影勾配法) */
  function mixture(cands, target) {
    var n = cands.length, x0 = [], sum = 0, i, k;
    cands.forEach(function (c) { sum += c.prior; });
    for (i = 0; i < n; i++) x0.push(cands[i].prior / sum);
    if (!target || n === 1) return x0;
    var x = x0.slice(), lambda = LAMBDA, step = 0.4;
    for (var iter = 0; iter < 200; iter++) {
      var mix = [0, 0, 0];
      for (i = 0; i < n; i++) for (k = 0; k < 3; k++) mix[k] += x[i] * cands[i].it.sh[k];
      var r = [mix[0] - target[0], mix[1] - target[1], mix[2] - target[2]];
      for (i = 0; i < n; i++) {
        var a = cands[i].it.sh;
        x[i] -= step * (2 * (a[0] * r[0] + a[1] * r[1] + a[2] * r[2]) + 2 * lambda * (x[i] - x0[i]));
      }
      x = simplex(x);
    }
    return x;
  }

  function simplex(v) {
    var u = v.slice().sort(function (a, b) { return b - a; }), css = 0, theta = 0;
    for (var i = 0; i < u.length; i++) {
      css += u[i];
      var t = (css - 1) / (i + 1);
      if (u[i] - t > 0) theta = t;
    }
    return v.map(function (x) { return Math.max(0, x - theta); });
  }

  /* PFCが分からない食品のエネルギー比を決める。名前で強く当たった食品(料理の見本を含む)があれば
     その割合、なければ料理名の語が同じ外食・商品の公表値、それも無ければ公表値全体の中央値 */
  function guessMacros(out, pool, strong, info, model, added) {
    var sim = model.sim, parts = [], salt = null, fiber = null, how = [];
    var nameSh = null, menu = null;
    if (pool.length) {
      var w = 0, acc = [0, 0, 0];
      pool.slice(0, 4).forEach(function (p) {
        if (!p.it.sh) return;
        w += p.s;
        for (var k = 0; k < 3; k++) acc[k] += p.s * p.it.sh[k];
      });
      if (w > 0) nameSh = acc.map(function (v) { return v / w; });
    }
    for (var i = 0; i < sim.profileWords.length; i++) {
      if (info.n.indexOf(sim.profileWords[i]) === -1) continue;
      menu = sim.profiles[sim.profileWords[i]];
      break;
    }
    /* 料理(弁当・丼・バーガー…)は、同じ料理名の外食・商品の公表値を主に使う
       (「弁当」の言い換えで ごはん が最有力になり、ごはん単体の割合で脂質が3割になった)。
       素材そのもの(ご飯・バナナ・豚こま肉…)は、名前の合う食品の割合を使う */
    var dish = sim.dishWords.some(function (d) { return info.n.indexOf(d) !== -1; }) ||
      (pool[0] && (pool[0].it.g === '18' || pool[0].it.g === 'dish'));
    if (menu && (dish || !strong)) {
      parts.push([menu[1], menu[2], menu[3]], [menu[1], menu[2], menu[3]]);
      salt = menu[4]; fiber = menu[5]; how.push('menu');
    }
    if (nameSh && (strong || !menu)) { parts.push(nameSh); how.push('name'); }
    if (!parts.length && sim.profileAll) {
      var all = sim.profileAll;
      parts.push([all[1], all[2], all[3]]); salt = all[4]; fiber = all[5]; how.push('menu-all');
    }
    if (!parts.length) return '';
    var sh = [0, 1, 2].map(function (k) {
      return parts.reduce(function (s, p) { return s + p[k]; }, 0) / parts.length;
    });
    var kcal = out.kcal;
    [['protein', sh[0] * kcal / 4], ['fat', sh[1] * kcal / 9], ['carb', sh[2] * kcal / 4]].forEach(function (pair) {
      if (finite(out[pair[0]])) return;
      out[pair[0]] = round(pair[1]);
      added.push(pair[0]);
    });
    if (!finite(out.salt) && finite(salt)) { out.salt = round(salt * kcal / 100); added.push('salt'); }
    if (!finite(out.fiber) && finite(fiber)) { out.fiber = round(fiber * kcal / 100); added.push('fiber'); }
    return how.join('+');
  }

  function weightedMedian(values, weights) {
    var rows = [];
    values.forEach(function (v, i) { if (finite(v) && weights[i] > 0) rows.push([v, weights[i]]); });
    if (!rows.length) return null;
    rows.sort(function (a, b) { return a[0] - b[0]; });
    var total = rows.reduce(function (s, r) { return s + r[1]; }, 0), acc = 0;
    for (var i = 0; i < rows.length; i++) {
      acc += rows[i][1];
      if (acc >= total / 2) return rows[i][0];
    }
    return rows[rows.length - 1][0];
  }

  // 名前に手がかりの無い商品(袋菓子・アイスなど)は、生の野菜・果物・きのこ・海藻・調味料からは選ばない
  var NO_HINT_SKIP = ['06', '07', '08', '09', '17', 'dish'];

  // 骨ごと・乾燥・粉など、カロリーあたりのカルシウムや鉄が極端な食品(ネギトロ巻 → ふなの甘露煮 になった)
  var CONCENTRATED = /甘露煮|つくだ煮|佃煮|干し|乾|粉|骨|缶詰|ふりかけ/;

  function neighbours(model, groups, target, exclude, limit, drinkOnly, family) {
    var rows = [];
    model.sim.items.forEach(function (it) {
      if (!it.sh || exclude[it.id]) return;
      if (drinkOnly && !it.drink) return;
      if (family) {
        if (!it.toks.some(function (x) { return x.t === family; })) return;
      } else if (groups ? groups.indexOf(it.g) === -1 : NO_HINT_SKIP.indexOf(it.g) !== -1) {
        return;
      }
      // 名前で当たった候補は別に加えるので、ここでは仲間でも除く(蒟蒻畑 → 凍みこんにゃく 乾)
      if (it.state === 'dry' || CONCENTRATED.test(it.n)) return;
      rows.push({ it: it, d: dist(it.sh, target) });
    });
    rows.sort(function (a, b) { return a.d - b.d; });
    return rows.slice(0, limit);
  }

  var LAMBDA = 0.1;
  var CAP = 3;           // 組み合わせの結果を、候補の中央値の何倍までにするか
  var TRACE = null;      // 確かめ用: 組み合わせの中身を記録する     // 組み合わせの割合を、名前の合い方で決めた割合に引き戻す強さ
  var VARIANT = '';      // 確かめ用の切り替え(空=組み合わせ / 'cap'=組み合わせを中央値の1.5倍以内に / 'median'=中央値)
  var STRONG_NAME = 4;   // 名前の合い方がこれ以上なら、名前の合う食品だけで組み合わせる

  function similar(name, out, known, added, rule, model, opts) {
    var info = nameInfo(name, model);
    var pool = info.pool.slice();
    // 対応表に名前は当たったが量・PFCが合わなかった食品も、似た食品の有力な候補にする
    if (rule && rule.ref && model.byId[rule.ref]) {
      var pinned = model.sim.items.filter(function (it) { return it.id === rule.ref; })[0];
      if (pinned && !pool.some(function (p) { return p.it === pinned; })) {
        pool.unshift({ it: pinned, s: Math.max(info.best, STRONG_NAME), sig: 'rule:' + rule.ref });
      }
    }
    // 同じ語でしか当たっていない食品は、いちばん合うものだけ残す
    // (チーズINハンバーグで、チーズ類ばかり並んでハンバーグが候補から落ちないように)
    var bySig = {}, diverse = [];
    pool.forEach(function (p) {
      if (bySig[p.sig]) return;
      bySig[p.sig] = 1;
      diverse.push(p);
    });
    var best = diverse.length ? diverse[0].s : 0;
    var macroHow = (MACROS.filter(function (k) { return finite(out[k]); }).length < 2)
      ? guessMacros(out, diverse, best >= STRONG_NAME, info, model, added) : '';
    var target = sharesOf(out);
    var sigma = macroHow ? 0.2 : 0.1;
    var compOf = function (it) {
      if (macroHow) return 1;
      return target && it.sh ? Math.exp(-Math.pow(dist(it.sh, target) / sigma, 2) / 2) : 1;
    };
    /* 名前が強く合っても、PFCの割合がまるで違えば別物(モスシェイク コーヒー は コーヒー浸出液 ではない)。
       そのときは名前で決めきれない扱いにする */
    var cands = diverse.filter(function (p) { return !!p.it.sh; }).map(function (p) {
      return { it: p.it, prior: (p.s / best) * (0.05 + compOf(p.it)), comp: compOf(p.it) };
    }).sort(function (a, b) { return b.prior - a.prior; }).slice(0, 6);
    if (macroHow && cands.length) {
      var topPrior = cands[0].prior;
      cands = cands.filter(function (c) { return c.prior >= topPrior * 0.7; });
    }
    var pinnedId = rule && rule.ref;
    /* お茶・野菜のようにカロリーのほとんど無い食品は「カロリーあたり」のカリウムなどが桁違いに多く、
       少し混ぜただけで何倍にもなる(答え合わせでモスのカリウムが合計2.3倍)。
       いちばん合う食品の1/4よりカロリーの薄い食品は組み合わせに入れない */
    if (cands.length) {
      var leadD = cands[0].it.d;
      cands = cands.filter(function (c, i) { return i === 0 || c.it.d >= leadD / 4; });
    }
    var x0 = cands.length && target && !macroHow ? mixture(cands, target) : null;
    var fit = 1;
    if (x0) {
      var fitSh = [0, 0, 0];
      cands.forEach(function (c, i) { for (var q = 0; q < 3; q++) fitSh[q] += x0[i] * c.it.sh[q]; });
      fit = distN(fitSh, target);
    }
    /* 名前が強く合い、しかもその食品(の組み合わせ)でPFCの割合を説明できるとき。
       名前が合ってもPFCがまるで違えば別物(モスシェイク コーヒー は コーヒー浸出液 ではない) */
    var strong = best >= STRONG_NAME && (!target || !!macroHow || fit <= 0.15 || cands.some(function (c) {
      var d = distN(c.it.sh, target);
      return d <= 0.17 || ((c.it.g === 'dish' || c.it.g === '18' || c.it.id === pinnedId) && d <= 0.35);
    }));
    var per = {}, lead = null, method, residual = 1, gpk = null;
    if (strong) {
      // 名前の合う食品を、PFCのエネルギー比が合う割合で組み合わせる
      var x = VARIANT === 'median' ? null : (x0 || mixture(cands, macroHow ? null : target));
      if (!x) {
        var ws = cands.map(function (c) { return c.prior; });
        F.KEYS.forEach(function (k) { per[k] = weightedMedian(cands.map(function (c) { return c.it.per[k]; }), ws); });
        x = ws;
      } else {
        var priors = cands.map(function (c) { return c.prior; });
        F.KEYS.forEach(function (k) {
          var v = 0, w = 0;
          cands.forEach(function (c, i) {
            if (x[i] <= 0 || !finite(c.it.per[k])) return;
            v += x[i] * c.it.per[k];
            w += x[i];
          });
          if (w <= 0.3) return;
          per[k] = v / w;
          /* 組み合わせの結果が、候補の中央値から大きく離れたら抑える。候補に極端な食品が混ざる
             (赤こんにゃく=着色に鉄を使い鉄が普通のこんにゃくの160倍)と、1つで何倍にもなるため */
          var m = weightedMedian(cands.map(function (c) { return c.it.per[k]; }), priors);
          if (finite(m) && m > 0) per[k] = Math.min(Math.max(per[k], m / CAP), m * CAP);
        });
      }
      var top = 0;
      x.forEach(function (v, i) { if (v > x[top]) top = i; });
      lead = cands[top].it;
      var xsum = x.reduce(function (a, v) { return a + v; }, 0) || 1;
      gpk = cands.reduce(function (a, c, i) { return a + x[i] / xsum * 100 / c.it.d; }, 0);
      if (TRACE) cands.forEach(function (c, i) {
        TRACE.push([+x[i].toFixed(3), c.it.id, c.it.n.slice(0, 30), 'd=' + c.it.d, 'fe/kcal=' + (c.it.per.fe || 0).toFixed(3)].join(' '));
      });
      if (target) {
        var mixSh = [0, 0, 0], xs = 0;
        x.forEach(function (v) { xs += v; });
        cands.forEach(function (c, i) { for (var q = 0; q < 3; q++) mixSh[q] += x[i] / xs * c.it.sh[q]; });
        residual = dist(mixSh, target);
      }
      method = 'similar';
    } else {
      /* 名前で決めきれないときは、名前の弱い候補と、名前から分かる食品群の中で
         PFCの割合が近い食品の、カロリーあたりの量の中央値(1つの食品の極端な値に引きずられない) */
      var groups = info.groups;
      // 名前の当たりがごく弱いとき(パリパリバー の「ぱり」など)は、その食品群に絞らない
      if (!groups && diverse.length && best >= STRONG_NAME / 2) {
        groups = [];
        diverse.slice(0, 3).forEach(function (p) { if (groups.indexOf(p.it.g) === -1) groups.push(p.it.g); });
      }
      var ruleWord = rule ? rule._kw.filter(function (k) { return info.n.indexOf(k) !== -1; })
        .reduce(function (a, k) { return k.length > a.length ? k : a; }, '') : '';
      if (rule && rule.grp && ruleWord.length >= 3 && (!groups || groups.indexOf(rule.grp) === -1)) {
        groups = (groups || []).concat([rule.grp]);
      }
      var rows = [], seen = {};
      diverse.slice(0, 5).forEach(function (p) {
        seen[p.it.id] = 1;
        rows.push({ it: p.it, prior: (p.s / STRONG_NAME) * (0.05 + compOf(p.it)) });
      });
      /* 候補の多くに共通する食材の語(にわとり・まぐろ…)があれば、その仲間の中でPFCの割合が近いものを選ぶ
         (蒸し鶏 は鶏の中から。食品群全体から選ぶと さば缶 になった) */
      var family = null;
      if (!info.dish) {
        // 同じ語でしか当たらない食品(鶏・豚・牛の肝臓)はまとめずに数える(v57。まとめると1つになり仲間が見つからなかった)
        var count = {};
        pool.slice(0, 8).forEach(function (p) {
          p.it.toks.forEach(function (x) { if (!x.cat && !x.light && x.t.length >= 2 && p.sig.split('|').indexOf(x.t) !== -1) count[x.t] = (count[x.t] || 0) + 1; });
        });
        Object.keys(count).forEach(function (t) { if (count[t] >= 2 && (!family || count[t] > count[family])) family = t; });
      }
      if (target) {
        var near = family ? neighbours(model, null, target, seen, 8, info.drink, family) : [];
        var inFamily = family ? rows.filter(function (r) { return r.it.toks.some(function (x) { return x.t === family; }); }).length : 0;
        /* 仲間が名前の候補と合わせて2つ以上あれば、食品群全体からは選ばない
           (若どりレバー焼 が、肝臓が3つしかないため食品群全体に広がり、あさり になった) */
        if (!family || near.length + inFamily < 2) near = neighbours(model, groups, target, seen, 10, info.drink);
        near.forEach(function (r) { rows.push({ it: r.it, prior: 0.05 + compOf(r.it) }); });
      }
      if (rows.length) {
        var weights = rows.map(function (r) { return r.prior; });
        F.KEYS.forEach(function (k) {
          per[k] = weightedMedian(rows.map(function (r) { return r.it.per[k]; }), weights);
        });
        gpk = weightedMedian(rows.map(function (r) { return 100 / r.it.d; }), weights);
        rows.sort(function (a, b) { return b.prior - a.prior; });
        lead = rows[0].it;
      }
      method = diverse.length ? 'similar-weak' : 'similar-group';
    }
    /* 組み合わせから計算した「食べた重さ」が非現実的なら、その分だけ減らす。
       こんにゃく・お茶・野菜はカロリーがほとんど無く、カロリーで伸ばすと1kg以上食べた計算になる
       (こんにゃく田楽 60kcal が 800g 分の鉄・カルシウムになった)。上限は名前の重さの1.25倍、分からなければ800g */
    var grams = recordGrams(name, opts);
    if (grams && out.kcal * 100 / grams > 950) grams = null;   // カロリーと合わない重さは使わない
    var maxG = grams ? grams * 1.25 : 800, shrink = 1;
    if (finite(gpk) && gpk * out.kcal > maxG) shrink = maxG / (gpk * out.kcal);
    F.KEYS.forEach(function (k) {
      if (k === 'kcal' || finite(out[k])) return;
      var v = finite(per[k]) ? per[k] : model.sim.medians[k];
      if (finite(v) && shrink < 1 && MACROS.indexOf(k) === -1) v *= shrink;
      if (!finite(v)) return;
      out[k] = round(v * out.kcal);
      added.push(k);
    });
    return finish(out, known, added, {
      conf: (strong && !macroHow && residual <= 0.08) ? 'mid' : 'low',
      ref: lead ? lead.id : '', cat: lead ? '似た食品: ' + lead.n : '全食品の中央値',
      method: (lead ? method : 'median') + (macroHow ? '+pfc-' + macroHow : '')
    }, opts.est);
  }

  /* ================= 推定値の固定(アンカー。v56) =================
     利用者の指示(2026-10-30):「v55までの栄養素補正で修正幅が小さい食品・メニューをアンカーとして固定」。
     推定の作りを変えるたびに記録の推定値が上下していた(v53→v55 で鉄の推定の43%が3割以上動いた)。
     記録済みの食品名ごとに v53 の推定(estimate-v53.js)と今の推定を比べ、差が ±25% 以内の栄養素だけ、
     今の値を「1kcalあたりの量」で固定する(差の大きいものは固定せず、今後の改良を反映させる)。
     ±25% は、v55の答え合わせで1品ごとの推定誤差が1.2〜1.5倍あるため、その範囲に収まった値は
     落ち着いているとみなした値。ごく少ない量どうしの差を大きく見ないよう、1食600kcalあたり1日分の5%を足して比べる。
     固定値は端末の中だけ(Store.Anchors。食品名は個人の記録なので公開データに入れない) */
  var ANCHORS = null;                    // { 正規化した食品名: { 栄養素: 1kcalあたりの量 } }
  var ANCHOR_LIMIT = Math.log(1.25);
  var DAILY_REF = {
    protein: 65, fat: 60, carb: 300, fiber: 21, salt: 7.5, satfat: 16, monofat: 20, polyfat: 15, n3: 2, n6: 10,
    chol: 300, k: 2500, ca: 700, mg: 340, fe: 7.5, zn: 10, vita: 850, vitd: 8.5, vite: 6, vitb1: 1.3, vitb2: 1.5,
    niacin: 14, vitb6: 1.3, vitb12: 2.4, folate: 240, vitc: 100
  };
  function anchorFor(name) { return (ANCHORS && ANCHORS[F.norm(name)]) || null; }
  function setAnchors(map) { ANCHORS = map || null; }

  /* 1つの食品名について、古い推定(legacy = EstimateV53)と今の推定を比べ、固定してよい栄養素の
     1kcalあたりの量を返す。固定するものが無ければ null。known は実測・手入力の値だけ */
  function anchorValues(name, known, opts, legacy) {
    known = known || {};
    if (!finite(known.kcal) || known.kcal <= 0) return Promise.resolve(null);
    var o = { unit: opts && opts.unit, amount: opts && opts.amount, est: null };
    return Promise.all([
      legacy.fill(name, known, o),
      fill(name, known, { unit: o.unit, amount: o.amount, est: null, noAnchor: true })
    ]).then(function (r) {
      var older = r[0], newer = r[1];
      if (!older || !newer || !newer.est) return null;
      var per = {}, count = 0;
      newer.est.keys.forEach(function (k) {
        if (k === 'sugar' || !DAILY_REF[k]) return;      // 糖質は炭水化物と食物繊維から計算し直す
        var a = older.nutrients[k], b = newer.nutrients[k];
        if (!finite(a) || !finite(b)) return;
        var floor = DAILY_REF[k] * 0.05 * known.kcal / 600;
        if (Math.abs(Math.log((b + floor) / (a + floor))) > ANCHOR_LIMIT) return;
        per[k] = b / known.kcal;
        count++;
      });
      return count ? per : null;
    });
  }

  function fill(name, known, opts) {
    opts = opts || {};
    known = known || {};
    return load().then(function (model) {
      if (!finite(known.kcal) || known.kcal <= 0 || supplement(name, model)) return null;
      var rule = matchingRule(name, model);
      /* 古い推定値は「分かっている値」ではないので外し、果物の成分表から推定し直す。
         実測・手入力の値(est.keys に無いもの)とkcalは残す */
      if (staleFruitEstimate(opts.est, rule)) {
        var measured = {};
        for (var mk in known) {
          if (mk === 'kcal' || opts.est.keys.indexOf(mk) === -1) measured[mk] = known[mk];
        }
        known = measured;
        var fresh = {};
        for (var ok in opts) fresh[ok] = opts[ok];
        fresh.est = null;
        opts = fresh;
      }
      var out = copyKnown(known), added = [];
      /* 固定した推定値(アンカー。v56)があれば、その栄養素はそれを使う。推定の作りを変えても動かない。
         実測・手入力の値(known にある項目)は固定値より優先する */
      var anchor = opts.noAnchor ? null : anchorFor(name), anchored = [];
      if (anchor) {
        for (var ak in anchor) {
          if (finite(out[ak]) || !finite(anchor[ak])) continue;
          out[ak] = round(anchor[ak] * out.kcal);
          added.push(ak);
          anchored.push(ak);
        }
      }
      var result = (function () {
        var needsNutrients = F.KEYS.some(function (k) { return k !== 'kcal' && !finite(out[k]); });
        if (!needsNutrients) return null;

        /* 対応表(rules)で食品と量まで決まるものは、その食品で補う。
           決まらないもの(カロリーしか分からない・PFCが代表食品と合わない・対応表に無い)は、
           似た食品から補う(similar。v54までは値を不明のままにしていた)。
           2026-09-22の実測では、全食品の中央値で補うと菓子のカリウム4.4倍などずれたため、
           名前の合う食品をPFCが合う割合で組み合わせ、名前で見つからなければ同じ食品群から選ぶ */
        if (rule && rule.recipe) {
          var recipe = recipeNutrients(rule, model);
          if (recipe && finite(recipe.nutrients.kcal) && recipe.nutrients.kcal > 0) {
            var recipeScale = out.kcal / recipe.nutrients.kcal;
            if (fitsReference(out, recipe.nutrients, recipeScale)) {
              addFromRecipe(out, recipe.nutrients, recipeScale, added);
              return finish(out, known, added, {
                conf: 'mid', ref: recipe.refs.join('+'), cat: rule.cat || '', method: 'recipe'
              }, opts.est);
            }
          }
        }

        if (rule && rule.ref && model.byId[rule.ref]) {
          var grams = ruleGrams(rule, opts);
          /* カロリーしか分かっていないときは、特定の食品に当てはめてカロリー比例で
             伸ばさない。脂や砂糖でカロリーだけ高い食品だと、参照先の重さを何倍にも
             見積もってしまい、栄養素がその倍率でついてしまう
             (実測: 肉類の鉄4.8倍・ビタミンA4.1倍、菓子のカリウム4.4倍)。
             重さが決まっている規則(grams)はそのまま使ってよい */
          var knownMacros = MACROS.filter(function (k) { return finite(out[k]); }).length;
          var method = 'dictionary', conf = 'mid';
          if (grams == null && knownMacros >= 2) grams = fitGrams(out, model.byId[rule.ref]);
          /* PFCが分かっていて代表食品と合わないもの(果物味の加工品など)は、カロリーで伸ばさない。
             カロリーしか分からない生の果物だけ、カロリーから重さを逆算する */
          if (grams == null && knownMacros < 2) {
            grams = kcalGrams(rule, out, model.byId[rule.ref], name);
            if (grams != null) { method = 'dictionary-kcal'; conf = 'mid'; }
          }
          if (grams != null && fitsReference(out, model.byId[rule.ref], grams / 100)) {
            addFromFood(out, model.byId[rule.ref], grams, added);
            return finish(out, known, added, {
              conf: conf, ref: rule.ref, cat: rule.cat || '', method: method
            }, opts.est);
          }
        }

        // 調理済みで外した規則も、どの食品かの手がかりには使う(量は決めない。v58)
        return similar(name, out, known, added, rule || matchingRule(name, model, true), model, opts);
      })();
      if (anchored.length) {
        if (!result) {
          result = finish(out, known, added, { conf: 'high', ref: '', cat: '固定した値', method: 'anchor' }, opts.est);
        } else if (result.est) {
          result.est.method = 'anchor+' + result.est.method;
        }
        if (result && result.est) result.est.anchored = anchored.slice();
      }
      return result;
    });
  }

  function isExcluded(name) {
    return load().then(function (model) { return supplement(name, model); });
  }

  // 採点画面の食品区分でも、推定除外と同じサプリ判定を再利用する。
  // 呼び出し前に load() を待つこと。
  function isSupplement(name) {
    return MODEL ? supplement(name, MODEL) : false;
  }

  /*
     v14より前は「若どりレバー」も汎用のレバー(食品番号11197)として
     補完されていた。保存済み記録のうち、その旧推定値だけを取り除き、
     鶏肝(11232)として再計算する。実測・手入力値とkcalは上書きしない。
  */
  function legacyChickenLiver(record) {
    if (!record || !record.name || !record.nutrients || !record.est) return false;
    var name = String(record.name);
    if (!/(?:若どり|若鶏|鶏)\s*レバー/.test(name)) return false;
    var keys = record.est.keys;
    if (!Array.isArray(keys) || !keys.length) return false;
    return String(record.est.ref || '') === '11197' || String(record.est.cat || '') === 'レバー';
  }

  function recalibrateChickenLiver(record, opts) {
    if (!legacyChickenLiver(record)) return Promise.resolve(null);
    opts = opts || {};
    var estimated = record.est.keys || [], known = {};
    for (var key in record.nutrients) {
      if (key === 'kcal' || estimated.indexOf(key) === -1) known[key] = record.nutrients[key];
    }
    return fill(record.name, known, {
      unit: opts.unit || record.unit || 'g',
      amount: opts.amount == null ? (record.amount || 1) : opts.amount,
      est: null
    }).then(function (filled) {
      if (!filled || String(filled.est && filled.est.ref || '') !== '11232') return null;
      var next = {};
      for (var k in record) next[k] = record[k];
      next.nutrients = filled.nutrients;
      next.est = filled.est;
      return next;
    });
  }

  /*
     果物の規則(byKcal)ができる前に記録した果物は、カロリーしか持っていないか、
     前の版でほかの方法(全食品の中央値など)で推定した値を持っている。
     それらを拾って、果物の成分表から補い直す。実測・手入力の値とkcalは上書きしない
     (fill は古い推定値だけを外し、欠けている項目を足す)。呼び出し前に load() を待つこと。
  */
  function needsFruitFill(record) {
    if (!MODEL || !record || !record.name || !record.nutrients) return false;
    var rule = matchingRule(record.name, MODEL);
    if (!rule || !rule.byKcal) return false;
    // ビタミンCが空のものと、前の版でほかの方法(全食品の中央値など)で推定したもの
    return !finite(record.nutrients.vitc) || staleFruitEstimate(record.est, rule);
  }

  function fillFruit(record, opts) {
    if (!needsFruitFill(record)) return Promise.resolve(null);
    opts = opts || {};
    return fill(record.name, record.nutrients, {
      unit: opts.unit || record.unit || 'g',
      amount: opts.amount == null ? (record.amount || 1) : opts.amount,
      est: record.est || null
    }).then(function (filled) {
      if (!filled || !finite(filled.nutrients.vitc)) return null;
      var next = {};
      for (var k in record) next[k] = record[k];
      next.nutrients = filled.nutrients;
      next.est = filled.est;
      return next;
    });
  }

  /*
     v33より前の推定は、カロリーしか無い食品にも全食品の中央値や代表食品のカロリー比を当てていた。
     9/22の実測で当てにならないと分かった値で、記録・マイ食品・セットに残っていた
     (2026-10-02 利用者の判断で整理)。推定値(est.keys)を外し、実測・手入力の値とkcalだけから
     今の決まりで推定し直す。今の決まりで推定できないもの(カロリーしか無い食品など)は値が不明に戻る。
     手で成分表の食品を紐づけた推定(manual-reference)は利用者の選択なので触らない。
     変わらないものは null を返す。呼び出し前に load() を待つこと。
  */
  function needsReestimate(record) {
    var est = record && record.est;
    return !!(record && record.name && record.nutrients && est && est.keys && est.keys.length &&
      est.method !== 'manual-reference');
  }

  function sameNutrients(a, b) {
    var keys = {};
    for (var k in (a || {})) keys[k] = 1;
    for (var k2 in (b || {})) keys[k2] = 1;
    for (var key in keys) {
      var x = a[key], y = b[key];
      if (finite(x) !== finite(y)) return false;
      if (finite(x) && Math.abs(x - y) > 1e-6) return false;
    }
    return true;
  }

  function reestimate(record, opts) {
    if (!needsReestimate(record)) return Promise.resolve(null);
    opts = opts || {};
    var keys = record.est.keys, measured = {};
    for (var k in record.nutrients) {
      if (k === 'kcal' || keys.indexOf(k) === -1) measured[k] = record.nutrients[k];
    }
    var unit = opts.unit || record.unit || 'g';
    var amount = opts.amount == null ? (record.amount || 1) : opts.amount;
    return F.loadProducts().then(function () {
      // 一致する商品公表値を先に戻す。成分表の代用商品は推定の印を残す。
      var merged = F.mergeProduct(record.name, measured, unit, amount, []);
      return fill(record.name, merged.nutrients, { unit: unit, amount: amount, est: merged.est }).then(function (filled) {
        return filled || { nutrients: merged.nutrients, est: merged.est };
      });
    }).then(function (filled) {
      var nutrients = filled.nutrients;
      var est = filled.est;
      if (sameNutrients(nutrients, record.nutrients) &&
          String(est ? est.keys.slice().sort() : '') === String(record.est.keys.slice().sort()) &&
          String(est ? est.method : '') === String(record.est.method || '') &&
          String(est ? est.ref : '') === String(record.est.ref || '')) return null;
      var next = {};
      for (var key in record) next[key] = record[key];
      next.nutrients = nutrients;
      if (est) next.est = est; else delete next.est;
      return next;
    });
  }

  global.Estimate = {
    load: load, fill: fill, isExcluded: isExcluded, isSupplement: isSupplement,
    needsReestimate: needsReestimate, reestimate: reestimate,
    isLegacyChickenLiver: legacyChickenLiver,
    recalibrateChickenLiver: recalibrateChickenLiver,
    needsFruitFill: needsFruitFill, fillFruit: fillFruit,
    // 確かめ用: 名前で当たった食品の一覧
    setAnchors: setAnchors, anchorFor: anchorFor, anchorValues: anchorValues,
    _nameInfo: function (name) { return MODEL ? nameInfo(name, MODEL) : null; },
    _trace: function (on) { var t = TRACE; TRACE = on ? [] : null; return t; },
    _variant: function (v, lambda, cap) {
      VARIANT = v || ''; if (lambda != null) LAMBDA = lambda; if (cap != null) CAP = cap;
    },
    MODEL_VERSION: 5
  };
})(window);
