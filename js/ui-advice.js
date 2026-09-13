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
  var ALCOHOL_NAME = /酒|ビール|ワイン|焼酎|日本酒|ハイボール|ウイスキー|ウィスキー|ブランデー|チューハイ|サワー|梅酒|カクテル|ホッピー|発泡酒|シャンパン|モルツ|エール|ストロング|スーパードライ|贅沢搾り|ほろよい|氷結|檸檬堂|金麦|淡麗|本麒麟|クリアアサヒ/i;

  /* 配点は Nutrition.WEIGHTS と同じで、合計はちょうど100点 */
  var GROUPS = [
    { key: 'kcal', icon: '🔥', label: 'カロリー', weight: 30,
      scored: ['kcal'], shown: ['kcal'], more: [] },
    { key: 'pfc', icon: '🍚', label: 'PFCバランス', weight: 24,
      scored: ['protein', 'fat', 'sugar'], shown: ['protein', 'fat', 'sugar', 'carb'], more: [] },
    { key: 'quality', icon: '🧂', label: '塩分・脂質の質', weight: 12,
      scored: ['salt', 'satfat'], shown: ['salt', 'satfat', 'chol'],
      more: ['monofat', 'polyfat', 'n3', 'n6'] },
    { key: 'micro', icon: '🥬', label: 'ビタミン・ミネラル', weight: 24,
      scored: ['fiber', 'ca', 'fe', 'vita', 'vitb1', 'vitb2', 'vitc'],
      shown: ['fiber', 'ca', 'fe', 'vita', 'vitb1', 'vitb2', 'vitc', 'vite'],
      more: ['k', 'mg', 'zn', 'vitd', 'niacin', 'vitb6', 'vitb12', 'folate'] },
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

  function render(view, state) {
    return prepareSourceClassification().then(function () {
      return period === 1 ? renderDay(view, state) : renderRange(view, state, period);
    })
      .then(function () { bind(view, state); });
  }

  function prepareSourceClassification() {
    return Promise.all([F.load(), F.loadProducts(), F.loadCategories(), global.Estimate.load()]).then(function (r) {
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
    });
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
    view.addEventListener('click', function (ev) {
      var rich = ev.target.closest('[data-rich]');
      if (rich) showRichFoods(rich.getAttribute('data-rich'));
    });
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
        var note = days + '日のうち ' + tracked.length + ' 日分の平均です' +
          (tracked.length < days ? '（記録のない ' + (days - tracked.length) + ' 日は除いています）' : '');
        var sources = averageSourceBreakdown(tracked);
        view.innerHTML = segHtml() + scoreCard(sc, true, [], note) + commentCard(cmts) +
          dailyScoreCard(daysData, tg) + groupedCard(sc, avg, tg, avgCoverage, avgEstimated, rangeActivity, sources);
      });
    });
  }

  function entrySourceType(entry) {
    var name = String((entry && entry.name) || '');
    if (global.Estimate && global.Estimate.isSupplement(name)) return 'supplement';
    if (ALCOHOL_NAME.test(name)) return 'alcohol';
    var ref = entry && entry.ref;
    var food = ref && sourceFoodById[ref.id];
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
        'が未記録です。食べなかった場合は記録タブで「食べなかった」を押すと採点の精度が上がります。</div>' : '') + '</div>';
  }

  function jpSlot(key) { return { breakfast: '朝食', lunch: '昼食', dinner: '夕食' }[key] || key; }
  function ring(t, color) {
    var r = 34, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(100, t)) / 100);
    return '<svg width="84" height="84" viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="' + r +
      '" fill="none" stroke="var(--line)" stroke-width="8"/><circle cx="42" cy="42" r="' + r +
      '" fill="none" stroke="' + color + '" stroke-width="8" stroke-linecap="round" stroke-dasharray="' +
      c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" transform="rotate(-90 42 42)"/></svg>';
  }

  function importedCard(imp) {
    if (!imp) return '';
    var src = imp.source || '取り込みデータ';
    return '<div class="card"><h3>' + A().esc(src) + 'の記録</h3>' +
      (imp.score != null ? '<div class="row between"><span class="small">当時の健康度</span><b>' + imp.score + ' 点</b></div>' : '') +
      (imp.advice ? '<div class="small" style="margin-top:8px;color:var(--tx2)">' + A().esc(imp.advice) + '</div>' : '') +
      '<div class="tiny muted" style="margin-top:8px">この日の栄養素は、記録した食品にカロリーしか無いため' +
      A().esc(src) + 'の日次集計で補っています。</div></div>';
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
    var h = '<div class="card score-groups"><div class="row between"><h3>採点と摂取量</h3>' +
      '<span class="tiny muted score-guide">帯の中に入っていれば適正</span></div>' + sourceLegend();
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
    return h + '<div class="tiny muted score-source">' +
      '<b>配点（合計100点）</b>：カロリー30・PFCバランス24・ビタミン/ミネラル24・塩分と脂質の質12・運動10。' +
      '体重の増減を決めるのは収支なのでカロリーを最大にし、減量中に筋肉量を左右するたんぱく質を次に置いています。' +
      'カロリーは目標の5%超過から減点が始まり、30%超で0点です（不足は15%まで許容）。' +
      'さらに、超過が1割を超えた日は総合点にも上限をかけます（25%超で70点、40%超で40点）。<br>' +
      '「栄養データ○%」は、その日食べたもののうち、その栄養素の値が分かっている割合です。' +
      '低いときは実際にはもっと摂れている可能性があります。' +
      '「うち推定○%」は、食品成分表から補った割合です。<br>' +
      '目標値は「日本人の食事摂取基準(2025年版)」の18〜64歳の推奨量・目安量・目標量が基準です。</div></div>';
  }

  function sourceLegend() {
    return '<div class="source-legend" aria-label="バーの読み方">' +
      '<span><i class="src-normal"></i>通常食品</span><span><i class="src-sweets"></i>お菓子</span>' +
      '<span><i class="src-alcohol"></i>お酒</span><span><i class="src-supplement"></i>サプリ</span>' +
      '<span><i class="lg-zone"></i>うすい緑＝適正の範囲</span>' +
      '<span><i class="lg-line"></i>基準値</span></div>' +
      '<div class="aim-legend"><span><b>↓</b>これ以下に抑える</span>' +
      '<span><b>↕</b>この範囲に</span><span><b>↑</b>これ以上とる</span>' +
      '<span><b>≒</b>目安に近づける</span></div>';
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

  /* 栄養素は3種類ある。どれなのかを名前の頭の記号で示す。
     ↓ これ以下に抑える(塩分など) / ↕ この範囲に(カロリー・PFC) / ↑ これ以上とる(ビタミン等) */
  function aimMark(target) {
    if (!target) return '';
    var mark = target.kind === 'max' ? '↓'
      : target.kind === 'band' ? '↕'
        : target.kind === 'min' ? '↑' : '≒';
    var label = target.kind === 'max' ? 'これ以下に抑える'
      : target.kind === 'band' ? 'この範囲に収める'
        : target.kind === 'min' ? 'これ以上とる' : '目安に近づける';
    return '<i class="aim" title="' + label + '" aria-label="' + label + '">' + mark + '</i>';
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

  function targetText(target) {
    if (target.kind === 'band') return N.fmt(target.goal) + '以上・' + N.fmt(target.max) + '以下';
    if (target.kind === 'min') return N.fmt(target.goal) + '以上';
    if (target.kind === 'max') return N.fmt(target.max || target.goal) + '以下';
    return N.fmt(target.goal) + '目安';
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
    var clickable = detail && !detail.excluded && (detail.kind === 'min' || detail.kind === 'band') &&
      detail.ratio < 1 && key !== 'exercise';
    var tag = clickable ? 'button' : 'div';
    // 1項目1行。名前｜判定｜バー｜摂取量 で、目標値は帯と縦線で表す
    var h = '<' + tag + ' class="nut-detail' + (clickable ? ' tappable' : '') +
      '" data-nutrient="' + key + '"' +
      (clickable ? ' data-rich="' + key + '"' : '') +
      ' title="' + A().esc(meta[0] + ' ' + (known ? N.fmt(value) : '—') + meta[1] +
        (judgeFull ? '（' + judgeFull + '）' : '') +
        (target ? '目標 ' + targetText(target) + ' ' + meta[1] : '')) + '">' +
      '<span class="nut-name">' + aimMark(target) + A().esc(meta[0]) + '</span>';
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
    h += '<span class="nut-val"><b>' + (est > 0 ? '約' : '') +
      (known ? N.fmt(value) : '—') + '</b><i>' + A().esc(meta[1]) + '</i>' +
      (clickable ? '<em>›</em>' : '') + '</span>';
    // 2行目: 判定と、例外があればその注記。判定を1行目から外したぶんバーが広くなる
    var notes = judge
      ? '<span class="judge-tag ' + cls + '" aria-label="' + A().esc(judgeFull) +
        '"><i class="judge-mark" aria-hidden="true">' + JUDGE_MARK[cls] + '</i>' + judge + '</span>'
      : '';
    if (detail && detail.excluded) notes += '<span>採点対象外</span>';
    // カバー率は9割を切ったときだけ。ふだん出すと何のことか分からず邪魔になる
    if (key !== 'exercise' && cov < 0.9) notes += '<span>栄養データ ' + Math.round(cov * 100) + '%</span>';
    if (est > 0) notes += '<span>うち推定 ' + Math.round(est * 100) + '%</span>';
    if (key === 'exercise' && activity && activity.hasData) {
      notes += '<span>運動記録 ' + N.fmt(activity.exerciseKcal) + ' kcal ＋ ' +
        (activity.walkSource === 'active' ? '活動エネルギー(実測) ' : '歩数由来 ') +
        N.fmt(activity.stepKcal) + ' kcal' +
        (activity.steps != null ? '（' + Math.round(activity.steps).toLocaleString() + '歩）' :
          activity.days != null ? '（データあり ' + activity.days + '/' + activity.totalDays + '日）' : '') +
        '</span>';
    }
    h += '<span class="nut-flags">' + notes + '</span>';
    return h + '</' + tag + '>';
  }

  function showRichFoods(key) {
    var meta = F.meta(key);
    A().openSheet(meta[0] + 'が多い食品', '<div class="empty">検索中…</div>');
    F.load().then(function (db) {
      var list = db.foods.filter(function (food) { return food[key] != null && food[key] > 0 && food.kcal != null; });
      list.sort(function (a, b) { return b[key] - a[key]; });
      var html = '<div class="tiny muted" style="margin-bottom:8px">100gあたりの含有量が多い順（食品成分表より）</div>' +
        list.slice(0, 40).map(function (food) {
          return '<div class="res"><b>' + A().esc(food.n) + '</b><span>' + meta[0] + ' ' + N.fmt(food[key]) + ' ' +
            meta[1] + ' ／ ' + Math.round(food.kcal) + ' kcal ／ ' + A().esc(F.groupName(food.g)) + '</span></div>';
        }).join('');
      document.getElementById('sheetBody').innerHTML = html;
    });
  }

  Views.advice = {
    render: render,
    _activityFor: activityFor,
    _addActivity: addActivity,
    _prepareSourceClassification: prepareSourceClassification,
    _sourceBreakdown: sourceBreakdown,
    _entrySourceType: entrySourceType
  };
})(window);
