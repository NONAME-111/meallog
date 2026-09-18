/* drum.js - 数量をドラム(回して選ぶ目盛り)で入れる部品。

   iPhoneの時刻ピッカーと同じく、桁ごとの列を指ではじいて回し、中央の帯に止まった値を選ぶ。
   数字キーボードで打つより押し間違いが少なく、片手で合わせやすい。

   ・個数  [整数 0〜20] . [小数1桁目] [小数2桁目]
       上限20はあすけんと同じ。あすけんの記録1.7万件も最大がちょうど20だった。
       小数を2桁にしたのは、0.33・0.66・0.25・0.75 などが490件あり、1桁では表せないため。
   ・重さ  [百] [十] [一] . [小数1桁目]   0.0〜999.9 g
       0〜999を1本の列にすると1000段を回すことになり、狙った値で止めにくい。

   列は縦スクロール＋scroll-snap で作る(ライブラリは使わない)。
   値は「中央の帯に止まった段」。回している途中の段は、指で回したときだけ値として拾う。
   プログラムで回すとき(候補ボタン・段のタップ)は先に値を確定し、途中の段は拾わない。
   こうしないと、候補を押してすぐ保存したときに回転途中の値が記録されてしまう。

   値の反映は描画コマ(requestAnimationFrame)に頼らない。コマが来ない状態では
   「値は1.5なのに見た目は2のまま」になった(検証で実際に起きた)。
   スクロールのたびにその場で段を計算し、候補ボタンは回さずにその位置へすぐ合わせる。 */
(function (global) {
  'use strict';

  var ROW = 36;   // 1段の高さ(px)。CSS の .drum-item と合わせる。小数にするとスナップ位置がずれる

  var KINDS = {
    count: {
      intKeys: ['int'],
      cols: [
        { key: 'int', size: 21, label: '整数', wide: true },
        { sep: '.' },
        { key: 'd1', size: 10, label: '小数第1位' },
        { key: 'd2', size: 10, label: '小数第2位' }
      ],
      max: 20,
      split: function (v) {
        var c = Math.round(clamp(v, 0, 20) * 100);
        return { int: Math.floor(c / 100), d1: Math.floor(c % 100 / 10), d2: c % 10 };
      },
      join: function (d) {
        return Math.min(20, (d.int * 100 + d.d1 * 10 + d.d2) / 100);
      },
      // 20のときは小数を0に戻す(20.5 などを選べないようにする)
      capped: function (d) { return d.int === 20 && (d.d1 || d.d2) ? { d1: 0, d2: 0 } : null; },
      text: function (v) { return String(Math.round(v * 100) / 100); }
    },
    gram: {
      intKeys: ['h', 't', 'o'],
      cols: [
        { key: 'h', size: 10, label: '百の位' },
        { key: 't', size: 10, label: '十の位' },
        { key: 'o', size: 10, label: '一の位' },
        { sep: '.' },
        { key: 'd1', size: 10, label: '小数第1位' }
      ],
      max: 999.9,
      split: function (v) {
        var c = Math.round(clamp(v, 0, 999.9) * 10);
        var n = Math.floor(c / 10);
        return { h: Math.floor(n / 100), t: Math.floor(n / 10) % 10, o: n % 10, d1: c % 10 };
      },
      join: function (d) {
        return (d.h * 1000 + d.t * 100 + d.o * 10 + d.d1) / 10;
      },
      capped: function () { return null; },
      text: function (v) { return String(Math.round(v * 10) / 10); }
    }
  };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function num(v) {
    var n = parseFloat(v);
    return isFinite(n) && n >= 0 ? n : 0;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function reduceMotion() {
    try { return global.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  /* host の中身をドラムに作り替える。
     opts: { kind: 'count' | 'gram', unit: '人前', value: 1.5, onChange: function (v) {} } */
  function create(host, opts) {
    opts = opts || {};
    var kind = KINDS[opts.kind] || KINDS.count;
    var start = kind.split(num(opts.value));

    host.classList.add('drum');
    host.setAttribute('role', 'group');
    host.innerHTML = '<div class="drum-wheel">' +
      kind.cols.map(function (c) {
        if (c.sep) return '<span class="drum-sep" aria-hidden="true">' + c.sep + '</span>';
        var items = '';
        for (var i = 0; i < c.size; i++) items += '<div class="drum-item" data-i="' + i + '">' + i + '</div>';
        return '<div class="drum-col' + (c.wide ? ' wide' : '') + '" data-key="' + c.key + '"' +
          ' role="spinbutton" tabindex="0" aria-label="' + c.label + '"' +
          ' aria-valuemin="0" aria-valuemax="' + (c.size - 1) + '">' +
          '<div class="drum-pad"></div>' + items + '<div class="drum-pad"></div></div>';
      }).join('') +
      '<span class="drum-unit">' + esc(opts.unit || '') + '</span>' +
      '<div class="drum-band" aria-hidden="true"></div>' +
      '</div>';

    var cols = {}, last = null, batch = false;

    Array.prototype.forEach.call(host.querySelectorAll('.drum-col'), function (el) {
      var st = cols[el.dataset.key] = {
        el: el, size: el.querySelectorAll('.drum-item').length,
        idx: start[el.dataset.key] || 0, target: null, timer: 0, shown: -1, shownEl: null
      };
      el.addEventListener('scroll', function () { onScroll(st); }, { passive: true });
      // 指やホイールで触ったら、プログラムの回転は打ち切って指に従う
      ['touchstart', 'pointerdown', 'wheel'].forEach(function (t) {
        el.addEventListener(t, function () { st.target = null; }, { passive: true });
      });
      // 見えている段をタップすると、その段まで回す
      el.addEventListener('click', function (e) {
        var it = e.target.closest('.drum-item');
        if (it) go(st, parseInt(it.dataset.i, 10), true);
      });
      el.addEventListener('keydown', function (e) {
        var d = { ArrowUp: 1, ArrowDown: -1, PageUp: 5, PageDown: -5 }[e.key];
        if (e.key === 'Home') d = -st.size;
        if (e.key === 'End') d = st.size;
        if (!d) return;
        e.preventDefault();
        go(st, st.idx + d, true);
      });
    });

    function fix(st, i) { return clamp(Math.round(i), 0, st.size - 1); }

    function digits() {
      var d = {};
      for (var k in cols) d[k] = cols[k].idx;
      return d;
    }

    function value() { return kind.join(digits()); }

    function emit() {
      var v = value();
      host.setAttribute('aria-label', '数量 ' + kind.text(v) + ' ' + (opts.unit || ''));
      if (v === last) return;
      last = v;
      if (opts.onChange) opts.onChange(v);
    }

    // 選ばれた段を太く、重さの頭の0(0150 の 0)は薄くする
    function paint() {
      var leading = true;
      kind.intKeys.forEach(function (k, n) {
        var st = cols[k];
        var dim = leading && n < kind.intKeys.length - 1 && st.idx === 0;
        if (!dim) leading = false;
        st.el.classList.toggle('lead', dim);
      });
      for (var k in cols) {
        var st = cols[k];
        if (st.shown === st.idx) continue;
        if (st.shownEl) st.shownEl.classList.remove('on');
        st.shownEl = st.el.querySelector('.drum-item[data-i="' + st.idx + '"]');
        if (st.shownEl) st.shownEl.classList.add('on');
        st.shown = st.idx;
        st.el.setAttribute('aria-valuenow', String(st.idx));
      }
    }

    // プログラムで回す。値は先に確定し、回転途中の段は値にしない。
    // 印(target)は滑らかに回すときだけ付ける。すぐ合わせる移動に付けると、
    // スクロールの知らせが来ないまま印が残り、指で回しても値が変わらなくなる(検証で起きた)
    function go(st, i, smooth) {
      i = fix(st, i);
      var top = i * ROW;
      st.idx = i;
      if (Math.abs(st.el.scrollTop - top) > 1) {
        if (smooth && !reduceMotion() && st.el.scrollTo) {
          st.target = i;
          st.el.scrollTo({ top: top, behavior: 'smooth' });
          // スクロールが1回も起きなかったときも、0.7秒後に見えている段へ値を合わせ直す
          clearTimeout(st.timer);
          st.timer = setTimeout(function () { settle(st); }, 700);
        } else {
          st.target = null;
          st.el.scrollTop = top;
        }
      }
      if (batch) return;
      paint();
      emit();
    }

    function onScroll(st) {
      var i = fix(st, st.el.scrollTop / ROW);
      if (st.target != null) {
        // プログラムで回している途中。着いたら印を外す。途中の段は値にしない
        if (i === st.target && Math.abs(st.el.scrollTop - i * ROW) < 2) st.target = null;
      } else if (i !== st.idx) {
        st.idx = i;
        paint();
        emit();
      }
      clearTimeout(st.timer);
      st.timer = setTimeout(function () { settle(st); }, 180);
    }

    // 回転が止まったあと。止まった段を値にし、上限を超えていれば戻す
    function settle(st) {
      st.target = null;
      var i = fix(st, st.el.scrollTop / ROW);
      if (i !== st.idx) { st.idx = i; paint(); emit(); }
      var back = kind.capped(digits());
      if (back) for (var k in back) go(cols[k], back[k], false);
    }

    function place() {
      for (var k in cols) cols[k].el.scrollTop = cols[k].idx * ROW;
    }

    // 初期位置。描画直後はレイアウトが決まっていないことがあるので、次のフレームでも合わせ直す
    place();
    paint();
    emit();
    requestAnimationFrame(place);

    return {
      value: value,
      text: function () { return kind.text(value()); },
      // 候補ボタンなど。桁ごとに値を出すと途中の値(250→200→250)が一瞬出るので、まとめて1回にする
      set: function (v) {
        var d = kind.split(num(v));
        batch = true;
        for (var k in cols) go(cols[k], d[k] || 0, false);
        batch = false;
        paint();
        emit();
      },
      max: kind.max
    };
  }

  global.Drum = { create: create, ROW: ROW };
})(window);
