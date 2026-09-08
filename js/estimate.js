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
      var byId = {}, candidates = [];
      (db.foods || []).forEach(function (food) {
        byId[food.id] = food;
        if (!finite(food.kcal) || food.kcal <= 0) return;
        var perKcal = {};
        F.KEYS.forEach(function (k) {
          if (k !== 'kcal' && finite(food[k])) perKcal[k] = food[k] * 100 / food.kcal;
        });
        candidates.push({ food: food, perKcal: perKcal });
      });

      var medians = {};
      F.KEYS.forEach(function (k) {
        if (k === 'kcal') return;
        medians[k] = median(candidates.map(function (c) { return c.perKcal[k]; }));
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
        candidates: candidates,
        medians: medians,
        rules: rules,
        excludes: (cats.excludes || []).map(F.norm).filter(Boolean)
      };
      return MODEL;
    });
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
      if (rule._kw.some(function (x) { return n.indexOf(x) !== -1; })) return rule;
    }
    return null;
  }

  /* 既知の kcal/P/F/C と代表食品が最も合う相当グラム数（最小二乗解）。 */
  function fitGrams(known, ref) {
    var keys = ['kcal'].concat(MACROS), numerator = 0, denominator = 0;
    keys.forEach(function (k) {
      if (!finite(known[k]) || !finite(ref[k])) return;
      var perGram = ref[k] / 100;
      if (!perGram) return;
      numerator += known[k] * perGram;
      denominator += perGram * perGram;
    });
    if (!denominator) return null;
    var grams = numerator / denominator;
    if (!finite(grams) || grams < 1 || grams > 1500) return null;

    var knownPfc = MACROS.filter(function (k) { return finite(known[k]) && finite(ref[k]); });
    if (knownPfc.length >= 2) {
      var residual = knownPfc.reduce(function (sum, k) {
        var predicted = ref[k] * grams / 100;
        return sum + Math.abs(predicted - known[k]) / Math.max(Math.abs(known[k]), 1);
      }, 0) / knownPfc.length;
      if (residual > 0.40) return null;
    }
    return grams;
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
    if (finite(rule.grams) && rule.grams > 0) return rule.grams * amount;
    return null;
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

  function addPerKcal(out, perKcal, kcal, added) {
    F.KEYS.forEach(function (k) {
      if (k === 'kcal' || finite(out[k]) || !finite(perKcal[k])) return;
      out[k] = round(perKcal[k] * kcal / 100);
      added.push(k);
    });
  }

  function nearest(known, candidates) {
    var kcal = known.kcal;
    var available = MACROS.filter(function (k) { return finite(known[k]); });
    if (available.length < 2) return null;
    var target = {};
    available.forEach(function (k) { target[k] = known[k] * 100 / kcal; });

    var rows = [];
    candidates.forEach(function (c) {
      var distance = 0;
      for (var i = 0; i < available.length; i++) {
        var key = available[i];
        if (!finite(c.perKcal[key])) return;
        var diff = c.perKcal[key] - target[key];
        distance += diff * diff;
      }
      rows.push({ c: c, distance: distance });
    });
    rows.sort(function (a, b) { return a.distance - b.distance; });
    rows = rows.slice(0, 15);
    if (!rows.length) return null;

    var predicted = {};
    F.KEYS.forEach(function (k) {
      if (k === 'kcal') return;
      predicted[k] = median(rows.map(function (x) { return x.c.perKcal[k]; }));
    });
    return predicted;
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
      v: 1
    };
  }

  function finish(out, original, added, info, oldEst) {
    if (finite(out.carb) && finite(out.fiber)) {
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
  function fill(name, known, opts) {
    opts = opts || {};
    known = known || {};
    return load().then(function (model) {
      if (!finite(known.kcal) || known.kcal <= 0 || supplement(name, model)) return null;
      var out = copyKnown(known), added = [], rule = matchingRule(name, model);
      var needsNutrients = F.KEYS.some(function (k) { return k !== 'kcal' && !finite(out[k]); });
      if (!needsNutrients) return null;

      if (rule && rule.recipe) {
        var recipe = recipeNutrients(rule, model);
        if (recipe && finite(recipe.nutrients.kcal) && recipe.nutrients.kcal > 0) {
          var recipeScale = out.kcal / recipe.nutrients.kcal;
          addFromRecipe(out, recipe.nutrients, recipeScale, added);
          return finish(out, known, added, {
            conf: 'high', ref: recipe.refs.join('+'), cat: rule.cat || '', method: 'recipe'
          }, opts.est);
        }
      }

      if (rule && rule.ref && model.byId[rule.ref]) {
        var grams = ruleGrams(rule, opts);
        if (grams == null) grams = fitGrams(out, model.byId[rule.ref]);
        if (grams != null) {
          addFromFood(out, model.byId[rule.ref], grams, added);
          return finish(out, known, added, {
            conf: 'high', ref: rule.ref, cat: rule.cat || '', method: 'dictionary'
          }, opts.est);
        }
      }

      if (rule && rule.grp) {
        var groupPrediction = nearest(out, model.candidates.filter(function (c) {
          return c.food.g === rule.grp;
        }));
        if (groupPrediction) {
          addPerKcal(out, groupPrediction, out.kcal, added);
          return finish(out, known, added, {
            conf: 'mid', ref: '', cat: rule.cat || '', method: 'group-knn'
          }, opts.est);
        }
      }

      var prediction = nearest(out, model.candidates);
      if (prediction) {
        addPerKcal(out, prediction, out.kcal, added);
        return finish(out, known, added, {
          conf: 'low', ref: '', cat: '', method: 'knn'
        }, opts.est);
      }

      addPerKcal(out, model.medians, out.kcal, added);
      return finish(out, known, added, {
        conf: 'low', ref: '', cat: '全食品中央値', method: 'median'
      }, opts.est);
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

  global.Estimate = {
    load: load, fill: fill, isExcluded: isExcluded, isSupplement: isSupplement,
    isLegacyChickenLiver: legacyChickenLiver,
    recalibrateChickenLiver: recalibrateChickenLiver,
    MODEL_VERSION: 2
  };
})(window);
