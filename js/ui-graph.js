/* ui-graph.js - グラフタブ(体重・体脂肪・摂取カロリー) */
(function (global) {
  'use strict';
  var Views = global.Views || (global.Views = {});
  var S = global.Store, F = global.Foods, N = global.Nutrition;

  var RANGES = [
    { key: 14, label: '2週間' }, { key: 30, label: '1か月' },
    { key: 90, label: '3か月' }, { key: 365, label: '1年' }
  ];
  var range = 30;

  function A() { return global.App; }

  function render(view, state) {
    var to = state.date;
    var from = S.shiftYmd(to, -(range - 1));
    return Promise.all([
      S.Body.all(),
      S.Entries.range(from, to),
      S.Exercise.range(from, to),
      A().targetsFor(to),
      S.Daily.range(from, to)
    ]).then(function (r) {
      var body = r[0].filter(function (x) { return x.date >= from && x.date <= to; });
      var entries = r[1], exercises = r[2], tg = r[3].tg, st = r[3].settings, daily = r[4];

      var days = [];
      for (var d = from; d <= to; d = S.shiftYmd(d, 1)) days.push(d);

      // 日ごとの栄養素: 記録した食品の合計を基本に、足りない項目を取り込みデータで補う
      var impMap = {};
      daily.forEach(function (x) { impMap[x.date] = x; });
      var byDay = {};
      entries.forEach(function (e) {
        (byDay[e.date] = byDay[e.date] || []).push(e.nutrients);
      });
      var perDay = {};
      days.forEach(function (dd) {
        var s = F.sum(byDay[dd] || []);
        var imp = impMap[dd];
        if (imp && imp.nutrients) {
          for (var k in imp.nutrients) {
            if (!s[k] && typeof imp.nutrients[k] === 'number') s[k] = imp.nutrients[k];
          }
        }
        perDay[dd] = s;
      });

      var kcalByDay = {}, burnByDay = {};
      days.forEach(function (dd) {
        if (perDay[dd].kcal) kcalByDay[dd] = perDay[dd].kcal;
      });
      exercises.forEach(function (x) {
        burnByDay[x.date] = (burnByDay[x.date] || 0) + (x.kcal || 0);
      });

      view.innerHTML =
        '<div class="seg" id="rangeSeg">' + RANGES.map(function (x) {
          return '<button' + (x.key === range ? ' class="on"' : '') + ' data-r="' + x.key + '">' +
            x.label + '</button>';
        }).join('') + '</div>' +
        card('体重の推移', 'cWeight', weightSummary(body, st)) +
        card('摂取カロリー', 'cKcal', kcalSummary(days, kcalByDay, tg)) +
        statsCard(days, perDay, body, kcalByDay, burnByDay, tg);

      view.querySelector('#rangeSeg').addEventListener('click', function (e) {
        var b = e.target.closest('[data-r]');
        if (!b) return;
        range = parseInt(b.dataset.r, 10);
        A().render();
      });

      drawWeight(view.querySelector('#cWeight'), days, body, st);
      drawKcal(view.querySelector('#cKcal'), days, kcalByDay, burnByDay, tg.kcal.goal);
    });
  }

  function card(title, canvasId, sub) {
    return '<div class="card"><h3>' + title + '</h3>' +
      (sub ? '<div class="small muted" style="margin:-4px 0 8px">' + sub + '</div>' : '') +
      '<div class="chart-wrap"><canvas class="chart" id="' + canvasId + '"></canvas></div></div>';
  }

  function weightSummary(body, st) {
    var ws = body.filter(function (x) { return x.weight; });
    if (!ws.length) return '記録がありません';
    var first = ws[0].weight, last = ws[ws.length - 1].weight;
    var diff = last - first;
    var s = '最新 ' + N.fmt(last) + ' kg ／ 期間内 ' + (diff > 0 ? '+' : '') + N.fmt(diff) + ' kg';
    if (st.goalWeight) s += ' ／ 目標 ' + N.fmt(st.goalWeight) + ' kg';
    return s;
  }

  function kcalSummary(days, kcalByDay, tg) {
    var vals = days.map(function (d) { return kcalByDay[d] || 0; }).filter(function (v) { return v > 0; });
    if (!vals.length) return '記録がありません';
    var avg = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
    return '記録した ' + vals.length + ' 日の平均 ' + Math.round(avg) + ' kcal ／ 目標 ' + tg.kcal.goal + ' kcal';
  }

  /* ---------------- 統計 ---------------- */
  function statsCard(days, perDay, body, kcalByDay, burnByDay, tg) {
    var recorded = days.filter(function (d) { return kcalByDay[d]; }).length;
    var totals = F.sum(days.map(function (d) { return perDay[d]; }));
    var n = recorded || 1;
    var toilets = body.reduce(function (a, x) { return a + ((x.toilet && x.toilet.length) || 0); }, 0);
    var bowelYes = body.filter(function (x) { return x.bowel === 'yes'; }).length;
    var burnTotal = days.reduce(function (a, d) { return a + (burnByDay[d] || 0); }, 0);

    return '<div class="card"><h3>期間のまとめ</h3>' +
      row('記録した日数', recorded + ' / ' + days.length + ' 日') +
      row('1日平均 たんぱく質', N.fmt((totals.protein || 0) / n) + ' g（目標 ' + tg.protein.goal + ' g）') +
      row('1日平均 脂質', N.fmt((totals.fat || 0) / n) + ' g（目標 ' + tg.fat.goal + ' g）') +
      row('1日平均 炭水化物', N.fmt((totals.carb || 0) / n) + ' g（目標 ' + tg.carb.goal + ' g）') +
      row('1日平均 食物繊維', N.fmt((totals.fiber || 0) / n) + ' g（目標 ' + tg.fiber.goal + ' g）') +
      row('1日平均 食塩相当量', N.fmt((totals.salt || 0) / n) + ' g（目標 ' + tg.salt.goal + ' g未満）') +
      row('運動による消費', Math.round(burnTotal) + ' kcal') +
      row('お通じがあった日', bowelYes + ' 日') +
      row('トイレの記録', toilets + ' 回') +
      '</div>';
  }

  function row(k, v) {
    return '<div class="row between" style="padding:6px 0;border-top:1px solid var(--line)">' +
      '<span class="small">' + k + '</span><b class="small">' + v + '</b></div>';
  }

  /* ---------------- Canvas 描画 ---------------- */
  function setup(cv, h) {
    var dpr = global.devicePixelRatio || 1;
    var w = cv.clientWidth || 320;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  function css(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  function niceScale(min, max) {
    if (!isFinite(min) || !isFinite(max)) return { lo: 0, hi: 1, step: 1 };
    if (min === max) { min -= 1; max += 1; }
    var span = max - min;
    var pad = span * 0.15;
    var lo = min - pad, hi = max + pad;
    var raw = (hi - lo) / 4;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var step = Math.ceil(raw / mag) * mag;
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    return { lo: lo, hi: hi, step: step };
  }

  function axisLabels(ctx, g, sc, w, h, pad, fmtFn) {
    ctx.font = '10px -apple-system,sans-serif';
    ctx.fillStyle = css('--tx3', '#9aa1ab');
    ctx.strokeStyle = css('--line', '#e3e6ea');
    ctx.lineWidth = 1;
    for (var v = sc.lo; v <= sc.hi + 1e-9; v += sc.step) {
      var y = g.y0 + (1 - (v - sc.lo) / (sc.hi - sc.lo)) * g.hgt;
      ctx.beginPath();
      ctx.moveTo(g.x0, y + 0.5); ctx.lineTo(w - pad.r, y + 0.5);
      ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(fmtFn(v), g.x0 - 4, y);
    }
    void h;
  }

  function dateTicks(ctx, g, days, pad, w) {
    ctx.font = '10px -apple-system,sans-serif';
    ctx.fillStyle = css('--tx3', '#9aa1ab');
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    var stepN = Math.max(1, Math.ceil(days.length / 6));
    for (var i = 0; i < days.length; i += stepN) {
      var x = g.x0 + (days.length === 1 ? g.wid / 2 : (i / (days.length - 1)) * g.wid);
      var p = days[i].split('-');
      ctx.fillText(+p[1] + '/' + +p[2], x, g.y0 + g.hgt + 5);
    }
    void pad; void w;
  }

  function grid(w, h, right) {
    var pad = { l: 36, r: right || 10, t: 10, b: 20 };
    return { x0: pad.l, y0: pad.t, wid: w - pad.l - pad.r, hgt: h - pad.t - pad.b, pad: pad };
  }

  function drawWeight(cv, days, body, st) {
    if (!cv) return;
    var s = setup(cv, 190), ctx = s.ctx, g = grid(s.w, s.h);
    var map = {};
    body.forEach(function (x) { if (x.weight) map[x.date] = x; });
    var pts = days.map(function (d, i) {
      return map[d] ? { i: i, w: map[d].weight, f: map[d].bodyFat } : null;
    }).filter(Boolean);

    if (!pts.length) { empty(ctx, s); return; }
    var fpts = pts.filter(function (p) { return typeof p.f === 'number' && isFinite(p.f) && p.f > 0; });
    if (fpts.length > 1) g = grid(s.w, s.h, 42);
    var vals = pts.map(function (p) { return p.w; });
    if (st.goalWeight) vals.push(st.goalWeight);
    var sc = niceScale(Math.min.apply(null, vals), Math.max.apply(null, vals));
    axisLabels(ctx, g, sc, s.w, s.h, g.pad, function (v) { return (Math.round(v * 10) / 10).toFixed(1); });
    dateTicks(ctx, g, days, g.pad, s.w);

    function X(i) { return g.x0 + (days.length === 1 ? g.wid / 2 : (i / (days.length - 1)) * g.wid); }
    function Y(v) { return g.y0 + (1 - (v - sc.lo) / (sc.hi - sc.lo)) * g.hgt; }

    if (st.goalWeight && st.goalWeight >= sc.lo && st.goalWeight <= sc.hi) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = css('--orange', '#f0902b');
      ctx.beginPath(); ctx.moveTo(g.x0, Y(st.goalWeight)); ctx.lineTo(g.x0 + g.wid, Y(st.goalWeight));
      ctx.stroke(); ctx.restore();
    }

    ctx.strokeStyle = css('--green', '#3aa76d');
    ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach(function (p, k) {
      var x = X(p.i), y = Y(p.w);
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = css('--green', '#3aa76d');
    pts.forEach(function (p) {
      ctx.beginPath(); ctx.arc(X(p.i), Y(p.w), 2.6, 0, Math.PI * 2); ctx.fill();
    });

    if (fpts.length > 1) {
      var fvals = fpts.map(function (p) { return p.f; });
      var fsc = niceScale(Math.min.apply(null, fvals), Math.max.apply(null, fvals));
      ctx.strokeStyle = css('--blue', '#3d7fd6');
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      fpts.forEach(function (p, k) {
        var x = X(p.i);
        var y = g.y0 + (1 - (p.f - fsc.lo) / (fsc.hi - fsc.lo)) * g.hgt;
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = css('--blue', '#3d7fd6');
      ctx.font = '10px -apple-system,sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('― 体脂肪率(右目盛)', g.x0 + 2, g.y0 + 2);
      rightAxisLabels(ctx, g, fsc);
    }
  }

  function rightAxisLabels(ctx, g, sc) {
    ctx.save();
    ctx.fillStyle = css('--blue', '#3d7fd6');
    ctx.font = '10px -apple-system,sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (var v = sc.lo; v <= sc.hi + 1e-9; v += sc.step) {
      var y = g.y0 + (1 - (v - sc.lo) / (sc.hi - sc.lo)) * g.hgt;
      ctx.fillText((Math.round(v * 10) / 10).toFixed(1) + '%', g.x0 + g.wid + 4, y);
    }
    ctx.restore();
  }

  function drawKcal(cv, days, kcalByDay, burnByDay, goal) {
    if (!cv) return;
    var s = setup(cv, 190), ctx = s.ctx, g = grid(s.w, s.h);
    var vals = days.map(function (d) { return kcalByDay[d] || 0; });
    if (!vals.some(function (v) { return v > 0; })) { empty(ctx, s); return; }
    var maxV = Math.max(goal * 1.2, Math.max.apply(null, vals));
    var sc = { lo: 0, hi: Math.ceil(maxV / 500) * 500, step: Math.ceil(maxV / 500) * 500 / 4 };
    axisLabels(ctx, g, sc, s.w, s.h, g.pad, function (v) { return String(Math.round(v)); });
    dateTicks(ctx, g, days, g.pad, s.w);

    function Y(v) { return g.y0 + (1 - (v - sc.lo) / (sc.hi - sc.lo)) * g.hgt; }
    var bw = Math.max(2, Math.min(16, g.wid / days.length * 0.68));

    days.forEach(function (d, i) {
      var v = kcalByDay[d] || 0;
      if (!v) return;
      var x = g.x0 + (days.length === 1 ? g.wid / 2 : (i / (days.length - 1)) * g.wid);
      var y = Y(v);
      ctx.fillStyle = (v > goal) ? css('--orange', '#f0902b') : css('--green', '#3aa76d');
      ctx.fillRect(x - bw / 2, y, bw, g.y0 + g.hgt - y);
      var b = burnByDay[d] || 0;
      if (b > 0) {
        ctx.fillStyle = css('--blue', '#3d7fd6');
        var bh = Math.min(g.y0 + g.hgt - y, (b / (sc.hi - sc.lo)) * g.hgt);
        ctx.fillRect(x - bw / 2, g.y0 + g.hgt - bh, bw, bh);
      }
    });

    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = css('--red', '#e0503f');
    ctx.beginPath(); ctx.moveTo(g.x0, Y(goal)); ctx.lineTo(g.x0 + g.wid, Y(goal)); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = css('--red', '#e0503f');
    ctx.font = '10px -apple-system,sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('目標 ' + goal, g.x0 + 2, Y(goal) - 2);
  }

  function empty(ctx, s) {
    ctx.fillStyle = css('--tx3', '#9aa1ab');
    ctx.font = '12px -apple-system,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('この期間の記録がありません', s.w / 2, s.h / 2);
  }

  Views.graph = { render: render };
})(window);
