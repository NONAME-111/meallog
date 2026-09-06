/* nutrition.js - 目標値の算出と栄養採点
   数値の根拠: 日本人の食事摂取基準(2025年版) 18-64歳の推奨量/目安量/目標量
   基礎代謝: 国立健康・栄養研究所の式(Ganpule 2007) */
(function (global) {
  'use strict';

  /* 18-64歳の1日あたり推奨量(男/女) */
  var RDA = {
    ca:      [750, 650],   fe:     [7.5, 10.5], mg:    [370, 290],  zn:    [11, 8],
    vita:    [900, 700],   vitd:   [8.5, 8.5],  vite:  [6.0, 5.0],
    vitb1:   [1.4, 1.1],   vitb2:  [1.6, 1.2],  niacin:[15, 11],
    vitb6:   [1.4, 1.1],   vitb12: [2.4, 2.4],  folate:[240, 240],  vitc: [100, 100],
    k:       [3000, 2600], fiber:  [21, 18]
  };
  /* 上限・目標量(男/女) */
  var LIMIT = {
    salt: [7.5, 6.5],
    chol: [300, 300]
  };

  function age(birth) {
    if (!birth) return 40;
    var b = new Date(birth), n = new Date();
    var a = n.getFullYear() - b.getFullYear();
    var m = n.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--;
    return (a > 0 && a < 120) ? a : 40;
  }

  /* 基礎代謝(kcal/日) */
  function bmr(settings, weightKg) {
    var w = weightKg || 60, h = settings.heightCm || 170;
    var a = age(settings.birth);
    var s = (settings.sex === 'female') ? 2 : 1;
    var v = (0.1238 + 0.0481 * w + 0.0234 * h - 0.0138 * a - 0.5473 * s) * 1000 / 4.186;
    return Math.max(900, Math.round(v));
  }

  function tdee(settings, weightKg) {
    return Math.round(bmr(settings, weightKg) * (settings.activity || 1.75));
  }

  /* 1日の目標摂取カロリー */
  function targetKcal(settings, weightKg) {
    if (settings.manualKcal) return Math.round(settings.manualKcal);
    var maint = tdee(settings, weightKg);
    var pace = settings.paceKgPerMonth;
    if (pace == null) pace = 2;
    var deficit = pace * 7200 / 30;          // 体脂肪1kg = 約7200kcal
    var floor = (settings.sex === 'female') ? 1200 : 1500;
    var v = Math.round(maint - deficit);
    return Math.max(floor, Math.min(maint, v));
  }

  /* 全項目の1日目標 */
  function targets(settings, weightKg) {
    var sexIdx = (settings.sex === 'female') ? 1 : 0;
    var kcal = targetKcal(settings, weightKg);
    var w = weightKg || 60;

    var protein = Math.round(Math.max(w * 1.2, kcal * 0.15 / 4));
    var fat = Math.round(kcal * 0.25 / 9);
    var carb = Math.round(Math.max(0, (kcal - protein * 4 - fat * 9) / 4));

    var t = {
      kcal: { goal: kcal, kind: 'range' },
      protein: { goal: protein, kind: 'min' },
      fat: { goal: fat, max: Math.round(kcal * 0.30 / 9), kind: 'max' },
      carb: { goal: carb, max: Math.round(kcal * 0.65 / 4), kind: 'max' },
      sugar: { goal: Math.round(carb * 0.85), max: Math.round(kcal * 0.60 / 4), kind: 'max' },
      satfat: { goal: Math.round(kcal * 0.07 / 9), kind: 'max' }
    };
    Object.keys(RDA).forEach(function (k) {
      t[k] = { goal: RDA[k][sexIdx], kind: 'min' };
    });
    Object.keys(LIMIT).forEach(function (k) {
      t[k] = { goal: LIMIT[k][sexIdx], kind: 'max' };
    });
    t.exercise = { goal: Math.max(1, Math.round(settings.exerciseKcalGoal || 200)), kind: 'min' };
    t._bmr = bmr(settings, w);
    t._tdee = tdee(settings, w);
    return t;
  }

  /* ---- 採点 ---- */
  var WEIGHTS = [
    ['kcal', 20], ['protein', 10], ['fat', 10], ['sugar', 8], ['fiber', 8],
    ['salt', 10], ['satfat', 6], ['ca', 6], ['fe', 6],
    ['vita', 4], ['vitb1', 4], ['vitb2', 4], ['vitc', 4], ['exercise', 10]
  ];

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function scoreOne(kind, intake, goal, max) {
    if (!goal) return 1;
    var r = intake / goal;
    if (kind === 'range') {
      var dev = Math.abs(intake - goal) / goal;
      return clamp(1 - Math.max(0, dev - 0.10) * 3, 0, 1);
    }
    if (kind === 'min') return clamp(r, 0, 1);
    // max: 上限までは満点、超えた分だけ急に減点
    var lim = max || goal;
    var rr = intake / lim;
    return rr <= 1 ? 1 : clamp(1 - (rr - 1) * 1.5, 0, 1);
  }

  /* totals: 実摂取量、ctx.coverage: 栄養素ごとの摂取カロリーカバー率 */
  function score(totals, tg, ctx) {
    ctx = ctx || {};
    var rawPoints = 0, includedWeight = 0, detail = [], excludedCount = 0;
    WEIGHTS.forEach(function (pair) {
      var key = pair[0], w = pair[1];
      var t = tg[key];
      if (!t) return;
      var hasValue = typeof totals[key] === 'number' && isFinite(totals[key]);
      var coverage = ctx.coverage && typeof ctx.coverage[key] === 'number'
        ? ctx.coverage[key] : (hasValue ? 1 : 0);
      var estimated = ctx.estimated && typeof ctx.estimated[key] === 'number'
        ? ctx.estimated[key] : 0;
      var excluded = !hasValue || coverage < 0.60;
      var intake = hasValue ? totals[key] : null;
      var s = excluded ? null : scoreOne(t.kind, intake, t.goal, t.max);
      if (excluded) excludedCount++;
      else { rawPoints += s * w; includedWeight += w; }
      detail.push({
        key: key, intake: intake, goal: t.goal, max: t.max, kind: t.kind,
        ratio: (!excluded && t.goal) ? intake / t.goal : null, sc: s, weight: w,
        coverage: coverage, estimated: estimated, excluded: excluded
      });
    });
    var insufficient = excludedCount * 2 >= detail.length || includedWeight <= 0;
    var total = insufficient ? null : Math.round(rawPoints * 100 / includedWeight);
    return {
      total: total, detail: detail, insufficient: insufficient,
      excludedCount: excludedCount,
      hasEstimated: detail.some(function (d) { return !d.excluded && d.estimated > 0; })
    };
  }

  /* ---- コメント生成 ---- */
  function comments(sc, tg, ctx) {
    var out = [];
    var d = sc.detail;
    var byKey = {};
    d.forEach(function (x) { byKey[x.key] = x; });

    if (sc.insufficient && ctx && ctx.hasEntries) {
      out.push({ icon: '📝', text: '栄養データが足りないため、今日は点数を出していません。記録の栄養素を補うと採点できます。' });
      return out;
    }

    var e = byKey.kcal;
    if (e && !e.excluded) {
      if (e.intake === 0) out.push({ icon: '📝', text: 'まだ記録がありません。食べたものを登録すると採点できます。' });
      else if (e.ratio < 0.7) out.push({ icon: '⚠️', text: '摂取カロリーが目標より大きく少ないです（' + Math.round(e.intake) + ' / ' + e.goal + ' kcal）。記録漏れが無いか確認してください。極端な不足は筋肉量の低下を招きます。' });
      else if (e.ratio > 1.15) out.push({ icon: '🔥', text: '目標より ' + Math.round(e.intake - e.goal) + ' kcal 多く摂っています。次の食事か翌日で調整しましょう。' });
      else out.push({ icon: '✅', text: 'カロリーは目標の範囲内です（' + Math.round(e.intake) + ' / ' + e.goal + ' kcal）。' });
    }

    // 不足しているもの(比率の低い順)
    var lacks = d.filter(function (x) {
      return !x.excluded && x.kind === 'min' && x.ratio < 0.8 && (ctx && ctx.hasEntries);
    }).sort(function (a, b) { return a.ratio - b.ratio; }).slice(0, 3);
    lacks.forEach(function (x) {
      var m = global.Foods.meta(x.key);
      out.push({
        icon: '🥬',
        text: (x.estimated > 0 ? '推定を含む目安では、' : '') + m[0] +
          (x.estimated > 0 ? 'が不足している可能性があります（' : 'が不足しています（') +
          fmt(x.intake) + ' / ' + fmt(x.goal) + ' ' + m[1] + '、達成率' +
          Math.round(x.ratio * 100) + '%）。' + suggestText(x.key)
      });
    });

    // 摂りすぎているもの
    var overs = d.filter(function (x) {
      return !x.excluded && x.kind === 'max' && x.intake > (x.max || x.goal);
    }).sort(function (a, b) { return b.ratio - a.ratio; }).slice(0, 3);
    overs.forEach(function (x) {
      var m = global.Foods.meta(x.key);
      var lim = x.max || x.goal;
      out.push({
        icon: '🧂',
        text: (x.estimated > 0 ? '推定を含む目安では、' : '') + m[0] +
          (x.estimated > 0 ? 'が目安を超えている可能性があります（' : 'が目安を超えています（') +
          fmt(x.intake) + ' / ' + fmt(lim) + ' ' + m[1] + '）。' + overText(x.key)
      });
    });

    var exercise = byKey.exercise;
    if (exercise && !exercise.excluded && exercise.ratio < 1 && out.length < 4) {
      out.push({ icon: '🏃', text: '運動は ' + Math.round(exercise.intake) + ' / ' +
        Math.round(exercise.goal) + ' kcal相当です。歩数や短い運動を少し足すと目標に近づきます。' });
    }

    if (ctx && ctx.hasEntries && out.length < 3) {
      out.push({ icon: '👍', text: 'バランスよく摂れています。この調子で続けましょう。' });
    }
    return out;
  }

  var SUGGEST = {
    protein: '肉・魚・卵・大豆製品・乳製品を1食に1品加えましょう。',
    fiber: '野菜・きのこ・海藻・雑穀を足すと増えます。',
    ca: '牛乳・ヨーグルト・チーズ・小魚・小松菜が効率的です。',
    fe: 'レバー・赤身肉・あさり・小松菜が豊富です。ビタミンCと一緒だと吸収が上がります。',
    mg: '海藻・ナッツ・大豆製品・玄米に多く含まれます。',
    zn: '牡蠣・赤身肉・チーズに多く含まれます。',
    vita: 'にんじん・かぼちゃ・ほうれん草・レバーが豊富です。',
    vitd: 'さけ・さんま・いわし・きのこ類に多く含まれます。',
    vite: 'アーモンド・かぼちゃ・植物油に多く含まれます。',
    vitb1: '豚肉・玄米・大豆に多く含まれます。',
    vitb2: 'レバー・卵・納豆・乳製品に多く含まれます。',
    niacin: 'かつお・まぐろ・鶏むね肉に多く含まれます。',
    vitb6: 'かつお・まぐろ・鶏肉・バナナに多く含まれます。',
    vitb12: '魚介類・レバー・貝類に多く含まれます。',
    folate: 'ほうれん草・ブロッコリー・枝豆・レバーが豊富です。',
    vitc: '果物・ブロッコリー・パプリカ・いも類で補えます。',
    k: '野菜・果物・いも類・大豆製品に多く含まれます。'
  };
  var OVERS = {
    fat: '揚げ物・脂身・ドレッシングを減らすと下がります。',
    sugar: '主食の量、菓子・甘い飲料を見直しましょう。',
    salt: '汁物を残す、麺類のつゆを飲み干さない、調味料をかけすぎないのが効果的です。',
    satfat: 'バター・生クリーム・脂身の多い肉を控えめに。',
    chol: '卵黄・レバー・魚卵の量を調整しましょう。',
    carb: '主食の量を1〜2割減らすと収まります。'
  };
  function suggestText(k) { return SUGGEST[k] || ''; }
  function overText(k) { return OVERS[k] || ''; }

  function fmt(v) {
    if (v == null) return '-';
    if (v >= 100) return String(Math.round(v));
    if (v >= 10) return (Math.round(v * 10) / 10).toFixed(1);
    return (Math.round(v * 100) / 100).toFixed(2).replace(/0$/, '');
  }

  /* ---- 運動の消費カロリー ---- */
  var METS = [
    { name: 'ウォーキング(ふつう)', met: 3.5 },
    { name: 'ウォーキング(速歩)', met: 4.3 },
    { name: 'ジョギング', met: 7.0 },
    { name: 'ランニング', met: 9.8 },
    { name: '自転車', met: 6.8 },
    { name: '水泳(クロール)', met: 8.3 },
    { name: '筋トレ(軽め)', met: 3.5 },
    { name: '筋トレ(高強度)', met: 6.0 },
    { name: 'ヨガ・ストレッチ', met: 2.5 },
    { name: '階段昇降', met: 8.8 },
    { name: '掃除・家事', met: 3.3 },
    { name: 'ゴルフ', met: 4.8 },
    { name: 'テニス', met: 7.3 },
    { name: 'ダンス', met: 5.5 }
  ];
  function burnedKcal(met, minutes, weightKg) {
    return Math.round(met * (minutes / 60) * (weightKg || 60) * 1.05);
  }

  global.Nutrition = {
    age: age, bmr: bmr, tdee: tdee, targetKcal: targetKcal, targets: targets,
    score: score, comments: comments, fmt: fmt,
    METS: METS, burnedKcal: burnedKcal, WEIGHTS: WEIGHTS
  };
})(window);
