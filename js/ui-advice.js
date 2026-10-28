/* ui-advice.js - 栄養採点とアドバイスのタブ */
(function (global) {
  'use strict';
  var Views = global.Views || (global.Views = {});
  var S = global.Store, F = global.Foods, N = global.Nutrition;

  function A() { return global.App; }

  var PERIODS = [
    { key: 1, label: '当日' }, { key: 7, label: '過去7日' }, { key: 30, label: '過去30日' }
  ];
  var period = 1;
  var sourceFoodById = {};
  var sourceSweetRules = [];
  var SOURCE_TYPES = ['normal', 'sweets', 'alcohol', 'supplement'];
  /* 「お酒」は飲むお酒だけ。名前だけで見ていたため、実際の記録で
     料理酒(133回。成分表17138は調味料類で食塩2.2g/100g)が お酒 に数えられ、
     飲んでいない日でも食塩のバーにお酒の色が出ていた。
     ほかに「スリムアップスリム ストロング・ファイバー(502回)」「ストロング 豪快のり(湖池屋)」も
     「ストロング」だけで お酒 になっていた。
     成分表の食品番号が分かるものは、名前ではなく食品群(16=アルコール飲料類)で判断する。 */
  var ALCOHOL_NAME = /酒|ビール|ワイン|焼酎|日本酒|ハイボール|ウイスキー|ウィスキー|ブランデー|チューハイ|サワー|梅酒|カクテル|ホッピー|発泡酒|シャンパン|モルツ|エール|ストロングゼロ|スーパードライ|贅沢搾り|ほろよい|氷結|檸檬堂|金麦|淡麗|本麒麟|クリアアサヒ/i;
  var ALCOHOL_NOT = /料理酒|料理の酒|みりん|味醂|酒粕|酒かす|粕漬|酒蒸|甘酒|ノンアルコール|ノンアル|アルコールゼロ|サワークリーム|サワーオニオン|サワーソース|ジンジャーエール|フルーツカクテル|カクテルゼリー|居酒屋/i;

  /* 配点は Nutrition.WEIGHTS と同じで、合計はちょうど100点 */
  var GROUPS = [
    { key: 'kcal', icon: '🔥', label: 'カロリー', weight: 30,
      scored: ['kcal'], shown: ['kcal'], more: [] },
    { key: 'pfc', icon: '🍚', label: 'PFCバランス', weight: 24,
      scored: ['protein', 'fat', 'sugar'], shown: ['protein', 'fat', 'sugar', 'carb'], more: [] },
    /* 「その他の項目」は、ほとんどが成分表からの推定で埋まっていて当てにならないので v32 で整理した。
       ・塩分・脂質の質: 一価/多価不飽和・n-3・n-6 は全部やめる
       ・ビタミン・ミネラル: カリウムだけ残す。食塩を摂りすぎた日の打ち消し(サプリを含む)を
         見たいため。ほかの7項目(マグネシウム・亜鉛・ビタミンD・ナイアシン・B6・B12・葉酸)はやめる */
    { key: 'quality', icon: '🧂', label: '塩分・脂質の質', weight: 12,
      scored: ['salt', 'satfat'], shown: ['salt', 'satfat', 'chol'], more: [] },
    { key: 'micro', icon: '🥬', label: 'ビタミン・ミネラル', weight: 24,
      scored: ['fiber', 'ca', 'fe', 'vita', 'vitb1', 'vitb2', 'vitc'],
      shown: ['fiber', 'k', 'ca', 'fe', 'vita', 'vitb1', 'vitb2', 'vitc', 'vite'],
      more: [] },
    { key: 'exercise', icon: '🏃', label: '運動', weight: 10,
      scored: ['exercise'], shown: ['exercise'], more: [] }
  ];

  /* 色だけで良し悪しを伝えないための記号と文字。
     緑と赤は1型色覚だと同じ色に見えるので、色は補助でしかない */
  var GROUP_VERDICT = {
    ok: { mark: '◎', text: '良好' },
    high: { mark: '△', text: '注意' },
    bad: { mark: '✕', text: '要改善' }
  };
  var JUDGE_MARK = { ok: '◎', low: '▼', high: '▲', bad: '✕' };
  /* 行を押したときに開く詳しい画面のための控え(描くたびに作り直す)。
     lastEntries は、その日(期間)の記録。「多くとった食品」を出すのに使う */
  var rowInfo = {};
  var lastEntries = [];

  function render(view, state) {
    return prepareSourceClassification().then(function () {
      return period === 1 ? renderDay(view, state) : renderRange(view, state, period);
    })
      .then(function () { bind(view, state); });
  }

  /* 食品区分の判定に要る成分表(約1MB)などを読む。一度読めたら使い回す(描くたびに作り直さない)。
     読めなかったときは次に呼ばれたときにやり直す */
  var sourcePrep = null, sourceIsReady = false;
  function prepareSourceClassification() {
    if (sourcePrep) return sourcePrep;
    sourcePrep = Promise.all([F.load(), F.loadProducts(), F.loadCategories(), global.Estimate.load()]).then(function (r) {
      sourceFoodById = {};
      (r[0].foods || []).forEach(function (food) { sourceFoodById[food.id] = food; });
      sourceSweetRules = (r[2].rules || []).filter(function (rule) {
        return String(rule.grp) === '15';
      }).map(function (rule) {
        return {
          kw: (rule.kw || []).map(F.norm).filter(Boolean),
          not: (rule.not || []).map(F.norm).filter(Boolean)
        };
      });
      sourceIsReady = true;
    });
    sourcePrep.catch(function () { sourcePrep = null; });
    return sourcePrep;
  }

  function segHtml() {
    return '<div class="seg" id="periodSeg">' + PERIODS.map(function (p) {
      return '<button' + (p.key === period ? ' class="on"' : '') +
        ' data-p="' + p.key + '">' + p.label + '</button>';
    }).join('') + '</div>';
  }

  function bind(view) {
    var seg = view.querySelector('#periodSeg');
    if (seg) seg.addEventListener('click', function (e) {
      var b = e.target.closest('[data-p]');
      if (!b) return;
      period = parseInt(b.dataset.p, 10); A().render();
    });
    /* view(#view)は描き直しても同じ要素なので、押したときの処理は1回だけ付ける。
       描くたびに足していた(v46まで)ため、表示を切り替えるほど同じ処理が重なっていた */
    if (!view._adviceTap) {
      view._adviceTap = true;
      view.addEventListener('click', function (ev) {
        var row = ev.target.closest('[data-detail]');
        if (row && view.contains(row)) showNutrientDetail(row.getAttribute('data-detail'));
      });
    }
  }

  function activityFor(exercises, body) {
    exercises = exercises || [];
    var walkExerciseKcal = exercises.filter(function (x) {
      return /歩数/.test(x.name || '');
    }).reduce(function (sum, x) {
      return sum + (typeof x.kcal === 'number' && isFinite(x.kcal) ? x.kcal : 0);
    }, 0);
    var exerciseKcal = exercises.filter(function (x) {
      return !/歩数/.test(x.name || '');
    }).reduce(function (sum, x) {
      return sum + (typeof x.kcal === 'number' && isFinite(x.kcal) ? x.kcal : 0);
    }, 0);
    var hasExercise = exercises.length > 0;
    var hasSteps = !!(body && typeof body.steps === 'number' && isFinite(body.steps));
    var steps = hasSteps ? Math.max(0, body.steps) : null;
    // ヘルスケアの活動エネルギーは実測なので、あればそれを使う。
    // 歩数x0.025の換算は、よく歩いた日で実測の半分以下になることがある
    var activeKcal = body && typeof body.activeKcal === 'number' && isFinite(body.activeKcal)
      ? Math.max(0, body.activeKcal) : null;
    var hasActive = activeKcal != null;
    // 歩数記録とbody.stepsは同じ歩行を表すため、併存時は更新可能なbody.stepsを優先する。
    var stepKcal = hasActive ? activeKcal : (hasSteps ? steps * 0.025 : walkExerciseKcal);
    return {
      hasData: hasExercise || hasSteps || hasActive,
      value: F.round(exerciseKcal + stepKcal, 1),
      exerciseKcal: F.round(exerciseKcal, 1), stepKcal: F.round(stepKcal, 1),
      walkExerciseKcal: F.round(walkExerciseKcal, 1), steps: steps,
      activeKcal: hasActive ? F.round(activeKcal, 1) : null,
      walkSource: hasActive ? 'active' : (hasSteps ? 'steps' : (walkExerciseKcal ? 'exercise' : ''))
    };
  }

  function addActivity(totals, coverage, estimated, activity) {
    totals = Object.assign({}, totals || {});
    coverage = Object.assign({}, coverage || {});
    estimated = Object.assign({}, estimated || {});
    totals.exercise = activity && typeof activity.value === 'number' ? activity.value : 0;
    coverage.exercise = 1;
    estimated.exercise = 0;
    return { totals: totals, coverage: coverage, estimated: estimated };
  }

  function renderDay(view, state) {
    return S.Entries.byDate(state.date).then(function (all) {
      var entries = all.filter(S.notSkip);
      return Promise.all([
        all, entries, A().targetsFor(state.date), S.dayTotals(state.date, all),
        S.Exercise.byDate(state.date), S.Body.get(state.date)
      ]);
    }).then(function (r) {
      var all = r[0], entries = r[1], tg = r[2].tg, dt = r[3];
      var activity = activityFor(r[4], r[5]);
      var data = addActivity(dt.totals, dt.coverage, dt.estimated, activity);
      if (typeof data.totals.sugar !== 'number') {
        var sugar = F.sugarOf(data.totals); if (sugar != null) data.totals.sugar = sugar;
      }
      var sc = N.score(data.totals, tg, { coverage: data.coverage, estimated: data.estimated });
      var hasEntries = entries.length > 0;
      if (!hasEntries) { sc.total = 0; sc.insufficient = false; }
      var cmts = N.comments(sc, tg, { hasEntries: hasEntries });
      var slots = {};
      entries.forEach(function (e) { slots[e.slot] = (slots[e.slot] || 0) + ((e.nutrients && e.nutrients.kcal) || 0); });
      var missing = ['breakfast', 'lunch', 'dinner'].filter(function (key) {
        return !slots[key] && !S.Entries.isSkipped(all, key);
      });
      var sources = sourceBreakdown(entries, data.totals);
      lastEntries = entries;
      view.innerHTML = segHtml() + scoreCard(sc, hasEntries, missing, '') + commentCard(cmts) +
        importedCard(dt.imported) + groupedCard(sc, data.totals, tg, data.coverage, data.estimated, activity, sources);
    });
  }

  function renderRange(view, state, days) {
    var to = state.date, from = S.shiftYmd(to, -(days - 1)), dates = [];
    for (var d = from; d <= to; d = S.shiftYmd(d, 1)) dates.push(d);
    return Promise.all([
      S.Entries.range(from, to), A().targetsFor(to), S.Exercise.range(from, to), S.Body.all()
    ]).then(function (r) {
      var rows = r[0], tg = r[1].tg, byDay = {}, exByDay = {}, bodyByDay = {};
      rows.forEach(function (e) { (byDay[e.date] = byDay[e.date] || []).push(e); });
      r[2].forEach(function (e) { (exByDay[e.date] = exByDay[e.date] || []).push(e); });
      r[3].forEach(function (b) { if (b.date >= from && b.date <= to) bodyByDay[b.date] = b; });
      return Promise.all(dates.map(function (date) {
        return S.dayTotals(date, byDay[date] || []).then(function (dt) {
          var real = (byDay[date] || []).filter(S.notSkip);
          var activity = activityFor(exByDay[date] || [], bodyByDay[date]);
          var data = addActivity(dt.totals, dt.coverage, dt.estimated, activity);
          if (typeof data.totals.sugar !== 'number') {
            var sugar = F.sugarOf(data.totals); if (sugar != null) data.totals.sugar = sugar;
          }
          return {
            date: date, totals: data.totals, coverage: data.coverage, estimated: data.estimated,
            activity: activity, sources: sourceBreakdown(real, data.totals),
            tracked: real.length > 0 || (byDay[date] || []).length > 0
          };
        });
      })).then(function (daysData) {
        var tracked = daysData.filter(function (x) { return x.tracked; });
        if (!tracked.length) {
          view.innerHTML = segHtml() + '<div class="card"><div class="empty">この期間に記録がありません</div></div>';
          return;
        }
        var avg = {}, coverageNumerator = {}, estimatedNumerator = {}, coveredKcal = 0;
        tracked.forEach(function (x) {
          for (var k in x.totals) {
            if (k !== 'exercise' && typeof x.totals[k] === 'number') avg[k] = (avg[k] || 0) + x.totals[k];
          }
          var dayKcal = typeof x.totals.kcal === 'number' && x.totals.kcal > 0 ? x.totals.kcal : 0;
          coveredKcal += dayKcal;
          Object.keys(x.coverage || {}).forEach(function (key) {
            if (key !== 'exercise') coverageNumerator[key] = (coverageNumerator[key] || 0) + x.coverage[key] * dayKcal;
          });
          Object.keys(x.estimated || {}).forEach(function (key) {
            if (key !== 'exercise') estimatedNumerator[key] = (estimatedNumerator[key] || 0) + x.estimated[key] * dayKcal;
          });
        });
        for (var key2 in avg) avg[key2] = F.round(avg[key2] / tracked.length, 2);
        var avgCoverage = {}, avgEstimated = {};
        F.KEYS.concat(['sugar']).forEach(function (key) {
          avgCoverage[key] = coveredKcal ? (coverageNumerator[key] || 0) / coveredKcal : 0;
          avgEstimated[key] = coveredKcal ? (estimatedNumerator[key] || 0) / coveredKcal : 0;
        });
        var activeDays = tracked.filter(function (x) { return x.activity.hasData; });
        var rangeActivity = {
          hasData: activeDays.length > 0,
          value: F.round(tracked.reduce(function (s, x) { return s + x.activity.value; }, 0) / tracked.length, 1),
          exerciseKcal: F.round(tracked.reduce(function (s, x) { return s + x.activity.exerciseKcal; }, 0) / tracked.length, 1),
          stepKcal: F.round(tracked.reduce(function (s, x) { return s + x.activity.stepKcal; }, 0) / tracked.length, 1),
          steps: null, days: activeDays.length, totalDays: tracked.length, isRange: true
        };
        avg.exercise = rangeActivity.value;
        avgCoverage.exercise = 1;
        avgEstimated.exercise = 0;
        var sc = N.score(avg, tg, { coverage: avgCoverage, estimated: avgEstimated });
        var cmts = N.comments(sc, tg, { hasEntries: true });
        // 「30日のうち30日分の平均です」は当たり前なので、欠けた日があるときだけ出す
        var note = tracked.length < days
          ? '記録のない ' + (days - tracked.length) + ' 日を除いた ' + tracked.length + ' 日分の平均です'
          : '';
        var sources = averageSourceBreakdown(tracked);
        lastEntries = rows.filter(S.notSkip);
        view.innerHTML = segHtml() + scoreCard(sc, true, [], note) + commentCard(cmts) +
          dailyScoreCard(daysData, tg) + groupedCard(sc, avg, tg, avgCoverage, avgEstimated, rangeActivity, sources);
      });
    });
  }

  function entrySourceType(entry) {
    var name = String((entry && entry.name) || '');
    if (global.Estimate && global.Estimate.isSupplement(name)) return 'supplement';
    var ref = entry && entry.ref;
    var food = ref && sourceFoodById[ref.id];
    // 成分表で分かるものは食品群で判断する(16=アルコール飲料類、15=菓子類)。
    // 料理酒は調味料類(17)なので、ここで お酒 にはならない
    if (food && String(food.g) === '16') return 'alcohol';
    if (!food && ALCOHOL_NAME.test(name) && !ALCOHOL_NOT.test(name)) return 'alcohol';
    if (food && String(food.g) === '15') return 'sweets';
    var product = F.productFor(name);
    if (product && /成分表\s*15\d{3}/.test(product.src || '')) return 'sweets';
    var normalized = F.norm(name);
    if (sourceSweetRules.some(function (rule) {
      return !rule.not.some(function (word) { return normalized.indexOf(word) !== -1; }) &&
        rule.kw.some(function (word) { return normalized.indexOf(word) !== -1; });
    })) return 'sweets';
    return 'normal';
  }

  function sourceKeys() {
    var seen = {}, keys = [];
    F.KEYS.concat(['sugar']).forEach(function (key) {
      if (!seen[key]) { seen[key] = true; keys.push(key); }
    });
    return keys;
  }

  function blankSources() {
    var out = {};
    sourceKeys().forEach(function (key) {
      out[key] = { normal: 0, sweets: 0, alcohol: 0, supplement: 0 };
    });
    return out;
  }

  function sourceBreakdown(entries, totals) {
    var out = blankSources();
    (entries || []).filter(S.notSkip).forEach(function (entry) {
      var type = entrySourceType(entry), nutrients = entry.nutrients || {};
      sourceKeys().forEach(function (key) {
        var value = nutrients[key];
        if (key === 'sugar' && !(typeof value === 'number' && isFinite(value))) value = F.sugarOf(nutrients);
        if (typeof value === 'number' && isFinite(value) && value > 0) out[key][type] += value;
      });
    });
    sourceKeys().forEach(function (key) {
      var total = totals && totals[key];
      if (!(typeof total === 'number' && isFinite(total)) || total < 0) return;
      var known = SOURCE_TYPES.reduce(function (sum, type) { return sum + out[key][type]; }, 0);
      if (!known) { out[key].normal = total; return; }
      if (known > total) {
        SOURCE_TYPES.forEach(function (type) { out[key][type] *= total / known; });
      } else {
        // 日次集計で補われた分と分類不能分は通常食品として扱う。
        out[key].normal += total - known;
      }
    });
    return out;
  }

  function averageSourceBreakdown(days) {
    var out = blankSources(), count = days.length || 1;
    days.forEach(function (day) {
      sourceKeys().forEach(function (key) {
        SOURCE_TYPES.forEach(function (type) { out[key][type] += day.sources[key][type] || 0; });
      });
    });
    sourceKeys().forEach(function (key) {
      SOURCE_TYPES.forEach(function (type) { out[key][type] = F.round(out[key][type] / count, 3); });
    });
    return out;
  }

  function dailyScoreCard(daysData, tg) {
    var h = '<div class="card"><h3>日ごとの点数</h3><div class="daybars">';
    daysData.forEach(function (x) {
      if (!x.tracked) {
        h += '<div class="daybar"><i style="height:0"></i><span class="tiny muted">—</span></div>'; return;
      }
      var t = N.score(x.totals, tg, { coverage: x.coverage, estimated: x.estimated }).total;
      if (t == null) {
        h += '<div class="daybar" title="' + A().esc(x.date) + ' データ不足"><i style="height:2%;background:var(--line)"></i><span class="tiny muted">?</span></div>'; return;
      }
      var color = t >= 80 ? 'var(--judge-ok)' : (t >= 60 ? 'var(--judge-warn)' : 'var(--judge-bad)');
      h += '<div class="daybar" title="' + A().esc(x.date) + ' ' + t + '点"><i style="height:' +
        Math.max(2, t) + '%;background:' + color + '"></i><span class="tiny muted">' + (+x.date.slice(8, 10)) + '</span></div>';
    });
    return h + '</div><div class="tiny muted" style="margin-top:6px">棒の高さがその日の点数、下の数字は日付です。「—」は記録のない日です。</div></div>';
  }

  function scoreCard(sc, hasEntries, missing, note) {
    var t = sc.total, dataShort = hasEntries && t == null, shown = dataShort ? 0 : (t || 0);
    var color = dataShort ? 'var(--tx3)' : t >= 80 ? 'var(--judge-ok)' :
      (t >= 60 ? 'var(--judge-warn)' : 'var(--judge-bad)');
    var label = !hasEntries ? '未記録' : dataShort ? 'データ不足' : t >= 90 ? '素晴らしい' :
      t >= 80 ? 'とても良い' : t >= 70 ? '良い' : t >= 60 ? 'もう少し' : t >= 40 ? '改善の余地あり' : '要改善';
    return '<div class="card score-card"><div class="score-ring">' + ring(shown, color) +
      '<div><div class="score-num" style="color:' + color + '">' + (dataShort ? '—' : t) +
      (dataShort ? '' : '<small> / 100点</small>') + '</div><div class="small muted">' + label + '</div></div></div>' +
      (dataShort ? '<div class="tiny muted">主要な採点項目の半分以上で栄養データが不足しています。</div>' : '') +
      (sc.kcalCap != null && t != null && t >= sc.kcalCap
        ? '<div class="tiny muted">カロリーが目標を大きく超えたため、この日の上限を ' +
          sc.kcalCap + ' 点にしています。</div>'
        : '') +
      (sc.hasEstimated ? '<div class="tiny muted">この点数には食品成分表からの推定値を含みます。</div>' : '') +
      (note ? '<div class="tiny muted">' + A().esc(note) + '</div>' : '') +
      (missing.length && hasEntries ? '<div class="tiny muted">' + missing.map(jpSlot).join('・') +
        'が未記録です（食べなかった日は記録タブの「食べなかった」で精度が上がります）。</div>' : '') + '</div>';
  }

  function jpSlot(key) { return { breakfast: '朝食', lunch: '昼食', dinner: '夕食' }[key] || key; }
  function ring(t, color) {
    var r = 27, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(100, t)) / 100);
    return '<svg width="68" height="68" viewBox="0 0 68 68" aria-hidden="true"><circle cx="34" cy="34" r="' + r +
      '" fill="none" stroke="var(--line)" stroke-width="7"/><circle cx="34" cy="34" r="' + r +
      '" fill="none" stroke="' + color + '" stroke-width="7" stroke-linecap="round" stroke-dasharray="' +
      c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" transform="rotate(-90 34 34)"/></svg>';
  }

  /* 取り込んだ日にだけ出る。本文が長い(実測403px)ので、点数だけ見出しに出してたたんでおく */
  function importedCard(imp) {
    if (!imp) return '';
    var src = imp.source || '取り込みデータ';
    return '<details class="card imported-card"><summary>' +
      '<span>' + A().esc(src) + 'の記録</span>' +
      (imp.score != null ? '<b>当時の健康度 ' + imp.score + ' 点</b>' : '') + '</summary>' +
      (imp.advice ? '<div class="small" style="margin-top:8px;color:var(--tx2)">' + A().esc(imp.advice) + '</div>' : '') +
      '<div class="tiny muted" style="margin-top:8px">この日の栄養素は、記録した食品にカロリーしか無いため' +
      A().esc(src) + 'の日次集計で補っています。</div></details>';
  }

  function commentCard(comments) {
    if (!comments.length) return '';
    return '<div class="card advice-card"><h3>アドバイス</h3>' + comments.map(function (c) {
      return '<div class="advice-li"><span>' + c.icon + '</span><span>' + A().esc(c.text) + '</span></div>';
    }).join('') + '</div>';
  }

  function groupedCard(sc, totals, tg, coverage, estimated, activity, sources) {
    var byKey = {};
    sc.detail.forEach(function (d) { byKey[d.key] = d; });
    rowInfo = {};
    var h = '<div class="card score-groups"><div class="row between"><h3>採点と摂取量</h3>' +
      '<span class="tiny muted score-guide">押すと目標と内訳</span></div>' + sourceLegend();
    GROUPS.forEach(function (group) {
      var sum = 0, included = 0;
      group.scored.forEach(function (key) {
        var d = byKey[key]; if (!d || d.excluded) return;
        sum += d.sc * d.weight; included += d.weight;
      });
      var points = included ? sum / included * group.weight : null;
      var pct = points == null ? 0 : points / group.weight * 100;
      var color = points == null ? 'muted' : pct >= 80 ? 'ok' : pct >= 60 ? 'high' : 'bad';
      var verdict = GROUP_VERDICT[color];
      h += '<section class="score-group" data-score-section="' + group.key + '"><div class="score-group-head score-group-static"><span class="score-group-title"><span>' + group.icon + '</span><b>' +
        group.label + '</b></span><span class="score-group-result ' + color + '">' +
        (points == null ? '対象外'
          : '<i class="judge-mark" aria-hidden="true">' + verdict.mark + '</i>' + verdict.text + ' ' +
            N.fmt(points) + ' / ' + group.weight + '点') + '</span></div>';
      h += '<div class="score-group-body">';
      group.shown.forEach(function (key) {
        h += nutrientRow(key, byKey[key], totals, tg, coverage, estimated, activity, sources);
      });
      if (group.more.length) {
        h += '<details class="score-more" data-score-more="' + group.key + '"><summary>その他の項目（' +
          group.more.length + '項目）</summary><div class="score-more-body">';
        group.more.forEach(function (key) {
          h += nutrientRow(key, byKey[key], totals, tg, coverage, estimated, activity, sources);
        });
        h += '</div></details>';
      }
      if (group.key === 'exercise' && (!activity || !activity.hasData)) {
        h += '<div class="exercise-connect">歩数が取り込まれていません。カラダタブの「歩数を取り込む」で入れると採点されます</div>';
      }
      h += '</div>';
      h += '</section>';
    });
    // 配点は各区分の見出し(◎良好 21.0 / 24点)に出ているので、ここでは繰り返さない。
    // 残りは普段読まないので折りたたんでおく(画面を短くするため)
    return h + '<details class="score-source"><summary>採点の決め方と出典</summary>' +
      '<div class="tiny muted">' +
      'カロリーは目標の5%超過から減点が始まり、30%超で0点です（不足は15%まで許容）。' +
      '超過が1割を超えた日は総合点にも上限をかけます（25%超で70点、40%超で40点）。' +
      '体重の増減を決めるのは収支なので、カロリーの配点を最大にしています。<br>' +
      '「値が不明 ○%」は、その日食べたもののうち、カロリーに直して○%ぶんの食品に、' +
      'その栄養素の値が登録されていないという意味です。' +
      '表示している量にはその分が入っていないので、実際はもっと多い可能性があります' +
      '（1割を切るまでは出しません）。' +
      '「推定で補った ○%」も同じ数え方で、カロリーに直して○%ぶんの食品の値を' +
      '食品成分表から推定して埋めた、という意味です。どちらも量(g)の割合ではありません。<br>' +
      '目標値は「日本人の食事摂取基準(2025年版)」の18〜64歳の推奨量・目安量・目標量が基準です。' +
      '</div></details></div>';
  }

  /* バーの読み方。v46までは「基準値」の線と、名前の前の ↓↕↑≒(これ以下/範囲/これ以上/目安)の
     説明も並べていたが、網かけ(適正の範囲)と同じことを3通りに言っていて読むことが多すぎた
     (利用者の指摘)。目標の種類と数値は、行を押した画面に文章で出す */
  function sourceLegend() {
    return '<div class="source-legend" aria-label="バーの読み方">' +
      '<span><i class="src-normal"></i>通常食品</span><span><i class="src-sweets"></i>お菓子</span>' +
      '<span><i class="src-alcohol"></i>お酒</span><span><i class="src-supplement"></i>サプリ</span>' +
      '<span><i class="lg-zone"></i>適正の範囲</span></div>';
  }

  function sourceBar(key, sources, width) {
    var row = sources && sources[key];
    var sum = row ? SOURCE_TYPES.reduce(function (total, type) { return total + (row[type] || 0); }, 0) : 0;
    if (!sum) return '<i class="src-normal" style="width:' + width + '%"></i>';
    return SOURCE_TYPES.map(function (type) {
      var part = width * (row[type] || 0) / sum;
      return part > 0 ? '<i class="src-' + type + '" style="width:' + part + '%"></i>' : '';
    }).join('');
  }

  function barSpec(target, value) {
    var goal = Number(target.goal) || 0;
    var upper = Number(target.max) || goal;
    var ceiling = target.kind === 'band' ? upper * 1.25 : upper * 1.4;
    if (!ceiling) ceiling = 1;
    var fill = Math.max(0, Math.min(100, Number(value || 0) / ceiling * 100));
    var markers = [];
    // 適正ゾーン: 目標値の文字を出さずに「どこに入っていればよいか」を帯で示す
    var zone = { from: 0, to: 100 };
    if (target.kind === 'band') {
      markers.push({ pct: goal / ceiling * 100, cls: 'lower' });
      markers.push({ pct: upper / ceiling * 100, cls: 'upper' });
      zone = { from: goal / ceiling * 100, to: upper / ceiling * 100 };
    } else {
      markers.push({ pct: upper / ceiling * 100, cls: 'goal' });
      if (target.kind === 'max') zone = { from: 0, to: upper / ceiling * 100 };
      else if (target.kind === 'min') zone = { from: goal / ceiling * 100, to: 100 };
      // 目安型は目標の前後10%が適正(判定のしきい値と合わせる)
      else zone = { from: goal * 0.9 / ceiling * 100, to: goal * 1.1 / ceiling * 100 };
    }
    zone.from = Math.max(0, Math.min(100, zone.from));
    zone.to = Math.max(zone.from, Math.min(100, zone.to));
    return { fill: fill, markers: markers, zone: zone };
  }

  function targetZone(spec) {
    var z = spec.zone;
    if (!z || z.to - z.from <= 0) return '';
    return '<u class="nut-zone" style="left:' + z.from + '%;width:' + (z.to - z.from) +
      '%" aria-hidden="true"></u>';
  }

  function targetMarkers(spec) {
    return spec.markers.map(function (marker) {
      return '<u class="nut-target-line ' + marker.cls + '" style="left:' + marker.pct + '%" aria-hidden="true"></u>';
    }).join('');
  }

  /* 目標を文章で。行を押した画面に出す(一覧の行には数値を出さず、網かけで示す) */
  function targetSentence(target, unit) {
    var u = unit ? ' ' + unit : '';
    if (target.kind === 'band') return N.fmt(target.goal) + '〜' + N.fmt(target.max) + u + ' の範囲';
    if (target.kind === 'min') return N.fmt(target.goal) + u + ' 以上とる';
    if (target.kind === 'max') return N.fmt(target.max || target.goal) + u + ' 以下に抑える';
    return N.fmt(target.goal) + u + ' 前後';
  }

  /* 判定の意味を、記号を知らなくても分かる言葉で(行を押した画面に出す) */
  function judgeWords(cls, judge) {
    if (cls === 'ok') return '目標どおり';
    if (cls === 'low') return '少し足りない';
    if (cls === 'high') return judge === '不足' ? '少し足りない' : '少し多い';
    if (cls === 'bad') return judge === '不足' ? 'かなり足りない' : 'かなり多い';
    return '';
  }

  function chipHtml(x) {
    return '<span class="n2-judge ' + x.chipCls + '">' +
      (x.chipMark ? '<i aria-hidden="true">' + x.chipMark + '</i>' : '') + x.chipText + '</span>';
  }

  function nutrientRow(key, detail, totals, tg, coverage, estimated, activity, sources) {
    var meta = F.meta(key), target = tg[key], value = detail ? detail.intake : totals[key];
    var known = typeof value === 'number' && isFinite(value);
    var cov = detail ? detail.coverage : (coverage && typeof coverage[key] === 'number' ? coverage[key] : (known ? 1 : 0));
    var est = detail ? detail.estimated : (estimated && estimated[key]) || 0;
    var limit = target ? (target.max || target.goal) : null;
    var ratio = known && target && target.goal ? value / target.goal : 0;
    var limitRatio = known && limit ? value / limit : 0;
    // 判定は「適正／不足／過剰」の3語に統一する。程度は記号(◎▼▲✕)で示す
    var cls = 'ok', judge = '適正';
    if (!known || (detail && detail.excluded)) { cls = 'muted'; judge = ''; }
    else if (target && target.kind === 'min') {
      cls = ratio >= 0.9 ? 'ok' : (ratio >= 0.7 ? 'low' : 'bad');
      judge = cls === 'ok' ? '適正' : '不足';
    }
    else if (target && target.kind === 'max') {
      cls = limitRatio <= 1 ? 'ok' : (limitRatio <= 1.3 ? 'high' : 'bad');
      judge = cls === 'ok' ? '適正' : '過剰';
    }
    else if (target && target.kind === 'band') {
      if (value >= target.goal && value <= target.max) { cls = 'ok'; judge = '適正'; }
      else if (value < target.goal) {
        cls = ratio >= 0.9 ? 'ok' : (ratio >= 0.7 ? 'low' : 'bad');
        judge = cls === 'ok' ? '適正' : '不足';
      } else {
        cls = limitRatio <= 1.3 ? 'high' : 'bad';
        judge = '過剰';
      }
    }
    else if (target) {
      var gap = Math.abs(ratio - 1);
      cls = gap <= 0.1 ? 'ok' : (gap <= 0.25 ? 'high' : 'bad');
      judge = cls === 'ok' ? '適正' : (ratio > 1 ? '過剰' : '不足');
    }
    else judge = '';

    // ✕ は「大きく外れている」の意味。読み上げにも残す
    var judgeFull = cls === 'bad' ? ('大きく' + judge) : judge;
    var excluded = !!(detail && detail.excluded);

    /* 判定の札。適正も含めて、どの行も名前のすぐ右の同じ位置に文字で出す(v47。利用者の指摘)。
       v46までは、適正は量の右に◎だけ・それ以外は2行目に札で、行の高さがばらばらだった。
       しかも◎に棒グラフ用の .ok(青の塗り)が効いてしまい、記号の見えない青い四角になっていた。
       札の記号は向きで決める(不足は▼・過剰は▲・大きく外れたら✕)。色は程度(適正/注意/大きく外れ) */
    var chip = { chipCls: 'j-none', chipMark: '', chipText: '' };
    if (!known) chip = { chipCls: 'j-none', chipMark: '？', chipText: '不明' };
    else if (excluded) chip = { chipCls: 'j-none', chipMark: '', chipText: '対象外' };
    else if (judge) {
      chip.chipCls = cls === 'ok' ? 'j-ok' : (cls === 'bad' ? 'j-bad' : 'j-warn');
      chip.chipMark = cls === 'ok' ? '◎' : (cls === 'bad' ? '✕' : (judge === '不足' ? '▼' : '▲'));
      chip.chipText = judge;
    }
    /* 値の確からしさは、目立たない短い注記を1行目に置くだけにする(詳しくは押した画面で)。
       「値が不明」「推定で補った」は、その日の食品をカロリーで割った割合(量(g)の割合ではない) */
    var lowData = key !== 'exercise' && known && cov < 0.9;
    var mostlyEstimated = known && est >= 0.5;   // 半分以上が推定のときだけ(全行に出ると邪魔)
    var note = [];
    if (lowData) note.push('不明' + Math.round((1 - cov) * 100) + '%');
    if (mostlyEstimated) note.push('推定' + Math.round(est * 100) + '%');

    rowInfo[key] = {
      key: key, value: value, known: known, cov: cov, est: est, target: target, cls: cls,
      judge: judge, judgeFull: judgeFull, excluded: excluded,
      chipCls: chip.chipCls, chipMark: chip.chipMark, chipText: chip.chipText,
      activity: key === 'exercise' ? activity : null, sources: sources && sources[key]
    };

    /* 1項目は2段で、どの行も同じ高さ。1段目: 名前｜判定｜注記｜量 / 2段目: 幅いっぱいのバー。
       目標の数値は行に出さず網かけで示し、押した画面に文章で出す */
    var label = meta[0] + ' ' + (known ? N.fmt(value) + ' ' + meta[1] : '値が不明') +
      (judgeFull ? '、' + judgeFull : '') + '。押すと目標と内訳';
    var h = '<button class="nut2" data-detail="' + key + '" aria-label="' + A().esc(label) + '">' +
      '<span class="n2-name">' + A().esc(meta[0]) + '</span>' + chipHtml(chip) +
      '<span class="n2-note">' + note.join(' ') + '</span>' +
      '<span class="n2-val"><b>' + (known && est > 0 ? '約' : '') + (known ? N.fmt(value) : '—') +
      '</b><i>' + A().esc(meta[1]) + '</i><em aria-hidden="true">›</em></span>';
    if (target) {
      var spec = barSpec(target, known ? value : 0);
      h += '<span class="nut-bar' + (key === 'exercise' ? '' : ' source-stack') + '">' +
        targetZone(spec) +
        (key === 'exercise'
          ? '<i class="' + cls + '" style="width:' + spec.fill + '%"></i>'
          : sourceBar(key, sources, spec.fill)) +
        targetMarkers(spec) + '</span>';
    } else {
      h += '<span class="nut-bar"></span>';
    }
    return h + '</button>';
  }

  /* 行を押したときの詳しい画面。一覧から外した「目標の数値・種類」「内訳」「値の確からしさ」をここにまとめる */
  function showNutrientDetail(key) {
    var x = rowInfo[key];
    if (!x) return;
    var meta = F.meta(key), unit = meta[1], esc = A().esc;
    var rows = [];
    var words = x.known && !x.excluded ? judgeWords(x.cls, x.judge) : '';
    rows.push(['判定', chipHtml(x) + (words ? ' <span class="nd-sub">' + words + '</span>' : '') +
      (x.excluded && x.known ? ' <span class="nd-sub">値が分からない食品が多いので採点に入れていません</span>' : '')]);
    rows.push(['とった量', x.known
      ? '<b>' + (x.est > 0 ? '約' : '') + N.fmt(x.value) + '</b> ' + esc(unit) +
        (period > 1 ? ' <span class="nd-sub">1日あたりの平均</span>' : '')
      : '値が分かりません']);
    if (x.target) rows.push(['目標', esc(targetSentence(x.target, unit))]);
    if (key === 'exercise' && x.activity && x.activity.hasData) {
      var a = x.activity;
      rows.push(['内訳', '運動記録 ' + N.fmt(a.exerciseKcal) + ' kcal ＋ ' +
        (a.walkSource === 'active' ? '活動エネルギー(実測) ' : '歩数から ') + N.fmt(a.stepKcal) + ' kcal' +
        (a.steps != null ? '（' + Math.round(a.steps).toLocaleString() + '歩）' :
          a.days != null ? '（データあり ' + a.days + '/' + a.totalDays + '日）' : '')]);
    }
    // 通常食品・お菓子・お酒・サプリの内訳(2種類以上あるときだけ)
    if (key !== 'exercise' && x.sources) {
      var parts = SOURCE_TYPES.filter(function (t) { return (x.sources[t] || 0) > 0; });
      if (parts.length > 1) {
        var names = { normal: '通常食品', sweets: 'お菓子', alcohol: 'お酒', supplement: 'サプリ' };
        rows.push(['内訳', parts.map(function (t) {
          return '<span class="nd-src"><i class="src-' + t + '"></i>' + names[t] + ' ' +
            N.fmt(x.sources[t]) + ' ' + esc(unit) + '</span>';
        }).join('')]);
      }
    }
    if (x.known && x.cov < 0.9 && key !== 'exercise') {
      var unknownPct = Math.round((1 - x.cov) * 100);
      rows.push(['値が不明', unknownPct + '% <span class="nd-sub">食べた物のうちカロリーに直して' + unknownPct +
        '%ぶんは、この値が登録されていません。実際はもっと多い可能性があります</span>']);
    }
    if (x.known && x.est > 0) {
      rows.push(['推定', Math.round(x.est * 100) + '% <span class="nd-sub">食べた物のうちカロリーに直して' +
        Math.round(x.est * 100) + '%ぶんは、食品成分表から推定した値です</span>']);
    }
    var html = '<dl class="nd-list">' + rows.map(function (r) {
      return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>';
    }).join('') + '</dl>';

    // その日(期間)に多くとった食品。値の分かる記録だけで数える
    if (key !== 'exercise') {
      var byName = {};
      (lastEntries || []).forEach(function (e) {
        var v = e.nutrients && e.nutrients[key];
        if (typeof v !== 'number' || !(v > 0)) return;
        byName[e.name] = (byName[e.name] || 0) + v;
      });
      var top = Object.keys(byName).map(function (n) { return { n: n, v: byName[n] }; })
        .sort(function (p, q) { return q.v - p.v; }).slice(0, 5);
      if (top.length) {
        html += '<h4 class="nd-h">' + (period > 1 ? 'この期間に多くとった食品（合計）' : 'この日に多くとった食品') + '</h4>' +
          top.map(function (t) {
            return '<div class="nd-food"><span>' + esc(t.n) + '</span><b>' + N.fmt(t.v) + ' ' + esc(unit) + '</b></div>';
          }).join('');
      }
    }
    // 足りないものは、成分表で多く含む食品を見られる(v46までは行を押すとここへ直行していた)
    var short = x.known && !x.excluded && x.target && key !== 'exercise' &&
      (x.target.kind === 'min' || x.target.kind === 'band') && x.value < x.target.goal;
    if (short) html += '<button class="btn line wide" id="ndRich" style="margin-top:12px">' +
      esc(meta[0]) + 'が多い食品を見る</button>';
    var body = A().openSheet(meta[0], html);
    var rich = body.querySelector('#ndRich');
    if (rich) rich.addEventListener('click', function () {
      A().pushSheet(function () { showNutrientDetail(key); });
      showRichFoods(key);
    });
  }

  function showRichFoods(key) {
    var meta = F.meta(key);
    // 一覧は後から入るので tall(高さ固定＋中のスクロール枠)で開く
    var body = A().openSheet(meta[0] + 'が多い食品', '<div id="richList"><div class="empty">検索中…</div></div>',
      { tall: true });
    F.load().then(function (db) {
      var list = db.foods.filter(function (food) { return food[key] != null && food[key] > 0 && food.kcal != null; });
      list.sort(function (a, b) { return b[key] - a[key]; });
      var html = '<div class="tiny muted" style="margin-bottom:8px">100gあたりの含有量が多い順（食品成分表より）</div>' +
        list.slice(0, 40).map(function (food) {
          return '<div class="res"><b>' + A().esc(food.n) + '</b><span>' + meta[0] + ' ' + N.fmt(food[key]) + ' ' +
            meta[1] + ' ／ ' + Math.round(food.kcal) + ' kcal ／ ' + A().esc(F.groupName(food.g)) + '</span></div>';
        }).join('');
      body.querySelector('#richList').innerHTML = html;
    });
  }

  Views.advice = {
    render: render,
    _activityFor: activityFor,
    _addActivity: addActivity,
    _prepareSourceClassification: prepareSourceClassification,
    _sourceReady: function () { return sourceIsReady; },
    _sourceBreakdown: sourceBreakdown,
    _entrySourceType: entrySourceType
  };
})(window);
