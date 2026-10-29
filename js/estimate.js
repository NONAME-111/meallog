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

  function load() {
    if (MODEL) return Promise.resolve(MODEL);
    if (loading) return loading;
    loading = Promise.all([F.load(), F.loadCategories()]).then(function (r) {
      var db = r[0], cats = r[1] || {};
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
      return MODEL;
    }).catch(function (e) { loading = null; throw e; });
    return loading;
  }

  function supplement(name, model) {
    var n = F.norm(name);
    if (/さぷり|かぷせる|たぶれっと|ちゅあぶる|びたみん剤|栄養補助食品|医薬品|ぷろていん|かりうむのめぐり/.test(n)) return true;
    if (/1日(?:分)?[0-9]*粒/.test(n) || /[0-9]錠/.test(n)) return true;
    return model.excludes.some(function (x) { return n.indexOf(x) !== -1; });
  }

  function matchingRule(name, model) {
    var n = F.norm(name);
    for (var i = 0; i < model.rules.length; i++) {
      var rule = model.rules[i];
      if (rule._not.some(function (x) { return n.indexOf(x) !== -1; })) continue;
      if (rule._kw.some(function (x) { return n.indexOf(x) !== -1; })) {
        if (rule.rawOnly) {
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
      var needsNutrients = F.KEYS.some(function (k) { return k !== 'kcal' && !finite(out[k]); });
      if (!needsNutrients) return null;

      /* カロリーしか分かっていない食品から、たんぱく質やビタミン・ミネラルを作り出さない。
         2026-09-22の実測(成分表の食品を伏せて推定させ真値と比較)では、
           菓子類のカリウム4.4倍・ビタミンB2 5.6倍 / し好飲料のビタミンB1 6.1倍 /
           肉類の鉄4.8倍 / 逆に野菜類はビタミンC 0.03倍・食物繊維 0.11倍
         と当てにならず、1日分でも カリウム+26%・亜鉛+26%・たんぱく質+32%(目標比)ずれていた。
         カロリーあたりの栄養素は食品によって桁が違うので、原理的に当てられない。
         分からないものは分からないままにし、採点側で「値が不明」として扱う。
         ただし、重さまで決まっている規則(recipe / grams付きの辞書)は根拠があるので使う。 */
      var macrosKnown = MACROS.filter(function (k) { return finite(out[k]); }).length;
      if (macrosKnown < 2) {
        var pinFood = rule && rule.ref ? model.byId[rule.ref] : null;
        var pinned = rule && (rule.recipe || (pinFood && (ruleGrams(rule, opts) != null ||
          kcalGrams(rule, out, pinFood, name) != null)));
        if (!pinned) return null;
      }

      if (rule && rule.recipe) {
        var recipe = recipeNutrients(rule, model);
        if (recipe && finite(recipe.nutrients.kcal) && recipe.nutrients.kcal > 0) {
          var recipeScale = out.kcal / recipe.nutrients.kcal;
          if (!fitsReference(out, recipe.nutrients, recipeScale)) return null;
          addFromRecipe(out, recipe.nutrients, recipeScale, added);
          return finish(out, known, added, {
            conf: 'mid', ref: recipe.refs.join('+'), cat: rule.cat || '', method: 'recipe'
          }, opts.est);
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

      // PFCが似ていても微量栄養素が同じとは限らない。対応食品・重量に
      // 根拠がない場合は不明のままにする。中央値や全食品の近傍で埋めない(v54)。
      return null;
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
    MODEL_VERSION: 3
  };
})(window);
