/* steps.js - Apple Health書き出しZIP/XMLと手入力から、日別の歩数と活動エネルギーを取り込む。 */
(function (global) {
  'use strict';
  var S = global.Store;

  function validDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    var parts = date.split('-').map(Number);
    if (parts[0] < 1900) return false;
    var d = new Date(parts[0], parts[1] - 1, parts[2]);
    return S.ymd(d) === date && date <= S.ymd(new Date());
  }

  /* 数字だけ、または YYYY-MM-DD:歩数 の貼り付けも予備手段として残す。 */
  function parse(text, date) {
    var value = String(text == null ? '' : text).trim(), map = {};
    if (!value) throw new Error('歩数データを入力してください');
    if (/^https?:\/\//i.test(value)) {
      var u;
      try { u = new URL(value); } catch (e) { throw new Error('URLの形式が正しくありません'); }
      date = u.searchParams.get('date') || date;
      value = u.searchParams.get('steps') || '';
    }
    if (/^\d+$/.test(value)) value = (date || S.ymd(new Date())) + ':' + value;
    var parts = value.split(/[\r\n,]+/).filter(function (v) { return v.trim(); });
    if (!parts.length || parts.length > 3000) throw new Error('日付と歩数を1日ずつ、3000日以内で入力してください');
    parts.forEach(function (part) {
      var match = /^\s*(\d{4}-\d{2}-\d{2})\s*:\s*(\d+)\s*$/.exec(part);
      if (!match || !validDate(match[1])) throw new Error('日付は今日以前の YYYY-MM-DD、歩数は0以上の整数で入力してください');
      var n = Number(match[2]);
      if (!Number.isSafeInteger(n)) throw new Error('歩数の値が大きすぎます');
      if (Object.prototype.hasOwnProperty.call(map, match[1])) throw new Error('同じ日付が重複しています: ' + match[1]);
      map[match[1]] = n;
    });
    return Object.keys(map).sort().map(function (d) { return { date: d, steps: map[d] }; });
  }

  function importText(text, date) {
    var rows;
    try { rows = parse(text, date); } catch (e) { return Promise.reject(e); }
    return S.Body.importSteps(rows);
  }

  function xmlText(value) {
    return String(value || '').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  function attributes(tag) {
    var out = {}, re = /([A-Za-z][\w:.-]*)="([^"]*)"/g, m;
    while ((m = re.exec(tag))) out[m[1]] = xmlText(m[2]);
    return out;
  }

  var STEP_TYPE = 'HKQuantityTypeIdentifierStepCount';
  var ENERGY_TYPE = 'HKQuantityTypeIdentifierActiveEnergyBurned';

  function healthCollector() {
    var maps = Object.create(null), meta = Object.create(null), seen = new Set();
    var energy = Object.create(null), energySeen = new Set();
    var recordCount = 0, duplicateCount = 0;
    function add(tag) {
      if (tag.indexOf(ENERGY_TYPE) !== -1) { addEnergy(tag); return; }
      if (tag.indexOf(STEP_TYPE) === -1) return;
      var a = attributes(tag);
      if (a.type !== STEP_TYPE || a.unit !== 'count') return;
      var value = Number(a.value), date = String(a.startDate || '').slice(0, 10);
      if (!isFinite(value) || value < 0 || !validDate(date)) return;
      var source = a.sourceName || '記録元不明';
      var key = [source, a.startDate || '', a.endDate || '', value].join('\u0001');
      if (seen.has(key)) { duplicateCount++; return; }
      seen.add(key);
      if (!maps[source]) {
        maps[source] = Object.create(null);
        meta[source] = { records: 0, intervals: Object.create(null) };
      }
      maps[source][date] = (maps[source][date] || 0) + value;
      var start = Date.parse(a.startDate || ''), end = Date.parse(a.endDate || '');
      if (isFinite(start) && isFinite(end) && end > start) {
        if (!meta[source].intervals[date]) meta[source].intervals[date] = [];
        meta[source].intervals[date].push([start, end]);
      }
      meta[source].records++;
      recordCount++;
    }
    /* 活動エネルギー(実測の消費kcal)。歩数と同じく記録元ごとに、完全重複だけ除く。
       単位は kcal のみ受ける(書き出しでは kcal 固定) */
    function addEnergy(tag) {
      var a = attributes(tag);
      if (a.type !== ENERGY_TYPE || a.unit !== 'kcal') return;
      var value = Number(a.value), date = String(a.startDate || '').slice(0, 10);
      if (!isFinite(value) || value < 0 || !validDate(date)) return;
      var source = a.sourceName || '記録元不明';
      var key = [source, a.startDate || '', a.endDate || '', value].join('\u0001');
      if (energySeen.has(key)) return;
      energySeen.add(key);
      if (!energy[source]) energy[source] = Object.create(null);
      energy[source][date] = (energy[source][date] || 0) + value;
    }

    function finish() {
      var sources = Object.keys(maps).map(function (name) {
        var rows = Object.keys(maps[name]).sort().map(function (date) {
          return { date: date, steps: Math.max(0, Math.round(maps[name][date])) };
        });
        var overlaps = 0;
        Object.keys(meta[name].intervals).forEach(function (date) {
          var intervals = meta[name].intervals[date].sort(function (a, b) { return a[0] - b[0]; });
          var maxEnd = -Infinity;
          intervals.forEach(function (interval) {
            if (interval[0] < maxEnd) overlaps++;
            if (interval[1] > maxEnd) maxEnd = interval[1];
          });
        });
        // 同じ記録元の活動エネルギーがあれば、日別合計を歩数の行に足しておく
        var kcalByDate = energy[name] || Object.create(null);
        var energyDays = 0;
        rows.forEach(function (row) {
          if (kcalByDate[row.date] == null) return;
          row.activeKcal = Math.round(kcalByDate[row.date] * 10) / 10;
          energyDays++;
        });
        return {
          name: name, records: meta[name].records, days: rows.length, rows: rows,
          from: rows.length ? rows[0].date : '', to: rows.length ? rows[rows.length - 1].date : '',
          total: rows.reduce(function (sum, row) { return sum + row.steps; }, 0), overlaps: overlaps,
          energyDays: energyDays
        };
      }).sort(function (a, b) { return b.days - a.days || b.records - a.records; });
      if (!sources.length) throw new Error('歩数データが見つかりませんでした');
      return {
        sources: sources, records: recordCount, duplicates: duplicateCount,
        overlaps: sources.reduce(function (sum, source) { return sum + source.overlaps; }, 0)
      };
    }
    return { add: add, finish: finish };
  }

  async function parseHealthXmlStream(stream, onProgress, totalBytes) {
    var reader = stream.getReader(), decoder = new TextDecoder('utf-8');
    var collector = healthCollector(), carry = '', loaded = 0, lastNotice = 0;
    while (true) {
      var part = await reader.read();
      if (part.done) break;
      loaded += part.value.byteLength;
      var text = carry + decoder.decode(part.value, { stream: true });
      var cut = text.lastIndexOf('>');
      if (cut < 0) {
        carry = text.slice(-200000);
        continue;
      }
      var complete = text.slice(0, cut + 1), match;
      carry = text.slice(cut + 1);
      var re = /<Record\b[^>]*>/g;
      while ((match = re.exec(complete))) collector.add(match[0]);
      if (onProgress && loaded - lastNotice > 1024 * 1024) {
        lastNotice = loaded;
        onProgress(totalBytes ? Math.min(99, Math.round(loaded / totalBytes * 100)) : null);
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
      }
    }
    carry += decoder.decode();
    var tailMatch, tailRe = /<Record\b[^>]*>/g;
    while ((tailMatch = tailRe.exec(carry))) collector.add(tailMatch[0]);
    if (onProgress) onProgress(100);
    return collector.finish();
  }

  function u16(view, at) { return view.getUint16(at, true); }
  function u32(view, at) { return view.getUint32(at, true); }

  async function zipExportEntry(file) {
    var tailSize = Math.min(file.size, 65557);
    var tailStart = file.size - tailSize;
    var tail = new DataView(await file.slice(tailStart).arrayBuffer());
    var eocd = -1;
    for (var i = tail.byteLength - 22; i >= 0; i--) {
      if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIPの終端情報が見つかりません。書き出し直してください');
    var entries = u16(tail, eocd + 10), dirSize = u32(tail, eocd + 12), dirOffset = u32(tail, eocd + 16);
    if (entries === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
      throw new Error('このZIPは大きすぎるため直接展開できません。ファイルAppでZIPを展開し、export.xmlを選んでください');
    }
    if (dirOffset + dirSize > file.size) throw new Error('ZIPの一覧情報が壊れています');
    var dirBuffer = await file.slice(dirOffset, dirOffset + dirSize).arrayBuffer();
    var dir = new DataView(dirBuffer), bytes = new Uint8Array(dirBuffer), decoder = new TextDecoder('utf-8');
    var at = 0, found = null;
    for (var n = 0; n < entries && at + 46 <= dir.byteLength; n++) {
      if (u32(dir, at) !== 0x02014b50) throw new Error('ZIPのファイル一覧を読めませんでした');
      var method = u16(dir, at + 10), compressed = u32(dir, at + 20), uncompressed = u32(dir, at + 24);
      var nameLength = u16(dir, at + 28), extraLength = u16(dir, at + 30), commentLength = u16(dir, at + 32);
      var localOffset = u32(dir, at + 42);
      var name = decoder.decode(bytes.slice(at + 46, at + 46 + nameLength));
      if (/(^|\/)export\.xml$/i.test(name)) {
        found = { name: name, method: method, compressedSize: compressed,
          uncompressedSize: uncompressed, localOffset: localOffset };
        break;
      }
      at += 46 + nameLength + extraLength + commentLength;
    }
    if (!found) throw new Error('ZIP内に apple_health_export/export.xml が見つかりません');
    if (found.uncompressedSize > 750 * 1024 * 1024) {
      throw new Error('export.xmlが750MBを超えています。ファイルAppでZIPを展開し、export.xmlを選んでください');
    }
    var localBuffer = await file.slice(found.localOffset, found.localOffset + 30).arrayBuffer();
    var local = new DataView(localBuffer);
    if (local.byteLength < 30 || u32(local, 0) !== 0x04034b50) throw new Error('ZIP内のexport.xmlを開けませんでした');
    found.dataOffset = found.localOffset + 30 + u16(local, 26) + u16(local, 28);
    if (found.dataOffset + found.compressedSize > file.size) throw new Error('ZIP内のexport.xmlが途中で切れています');
    return found;
  }

  async function zipEntryStream(file, entry) {
    var stream = file.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize).stream();
    if (entry.method === 0) return stream;
    if (entry.method !== 8) throw new Error('このZIPの圧縮方式には対応していません');
    if (typeof global.DecompressionStream !== 'function') {
      throw new Error('このiPhoneではZIPを直接展開できません。ファイルAppでZIPをタップして展開し、export.xmlを選んでください');
    }
    try {
      return stream.pipeThrough(new global.DecompressionStream('deflate-raw'));
    } catch (e) {
      throw new Error('ZIPを展開できません。ファイルAppでZIPをタップして展開し、export.xmlを選んでください');
    }
  }

  async function parseHealthFile(file, onProgress) {
    if (!file || !file.size) throw new Error('ヘルスケアのZIPまたはexport.xmlを選んでください');
    var lower = String(file.name || '').toLowerCase();
    if (lower.endsWith('.xml') || /xml/.test(file.type || '')) {
      return parseHealthXmlStream(file.stream(), onProgress, file.size);
    }
    if (!lower.endsWith('.zip') && !/zip/.test(file.type || '')) {
      throw new Error('ヘルスケアから書き出したZIPまたはexport.xmlを選んでください');
    }
    var entry = await zipExportEntry(file);
    return parseHealthXmlStream(await zipEntryStream(file, entry), onProgress, entry.uncompressedSize);
  }

  function openImport(initial) {
    var A = global.App;
    var body = A.openSheet('ヘルスケアから取り込む',
      '<div class="step-method"><b>ヘルスケアから複数日分を一括取り込み</b>' +
      '<ol class="step-guide"><li>iPhoneの「ヘルスケア」を開く</li>' +
      '<li>「概要」右上のプロフィール画像 →「すべてのヘルスケアデータを書き出す」</li>' +
      '<li>「書き出す」→「ファイルに保存」でZIPを保存する</li>' +
      '<li>下の欄で、そのZIPを選ぶ</li></ol>' +
      '<p class="tiny"><a href="https://support.apple.com/ja-jp/guide/iphone/iph5ede58c3d/ios" target="_blank" rel="noopener">Apple公式の書き出し手順</a></p></div>' +
      '<label class="fld health-file"><span>ヘルスケアのZIP（または展開後のexport.xml）</span>' +
      '<input type="file" id="healthFile" accept=".zip,.xml,application/zip,text/xml,application/xml"></label>' +
      '<p class="small muted health-status" id="healthStatus" role="status" aria-live="polite"></p>' +
      '<div id="healthSourceWrap" hidden><label class="fld"><span>取り込む記録元</span>' +
      '<select id="healthSource"></select></label>' +
      '<div class="health-preview" id="healthPreview"></div>' +
      '<p class="tiny muted" id="healthSourceNote"></p></div>' +
      '<button class="btn wide" id="healthSave" disabled>この記録元から取り込む</button>' +
      '<p class="tiny muted">ZIPは外部へ送らず、この端末内だけで読み取ります。同じ日の歩数は加算せず、選んだ記録元の最新合計へ置き換えます。</p>' +
      '<p class="tiny muted">1日分だけなら、この画面を閉じて「歩数」の欄に直接入力できます。</p>');

    var fileInput = body.querySelector('#healthFile');
    var status = body.querySelector('#healthStatus');
    var wrap = body.querySelector('#healthSourceWrap');
    var select = body.querySelector('#healthSource');
    var previewBox = body.querySelector('#healthPreview');
    var note = body.querySelector('#healthSourceNote');
    var save = body.querySelector('#healthSave');
    var parsed = null;

    function selectedSource() {
      return parsed && parsed.sources[Number(select.value) || 0];
    }
    function drawSource() {
      var source = selectedSource();
      if (!source) return;
      previewBox.innerHTML = '<b>' + A.esc(source.days + '日分') + '</b><span>' +
        A.esc(source.from + ' ～ ' + source.to) + '</span><span>' +
        A.esc(source.records.toLocaleString() + '件の記録') + '</span>' +
        (source.energyDays
          ? '<span>活動エネルギー(実測の消費kcal) <strong>' + source.energyDays + '日分</strong></span>'
          : '<span>活動エネルギーはこの記録元にありません</span>') +
        '<span><strong>同じ日の保存済み歩数には上乗せしません</strong></span>';
      var messages = [];
      if (parsed.sources.length > 1) {
        messages.push('iPhoneとApple Watchを同時に合算すると重複するため、記録元を1つだけ選びます。');
      }
      if (parsed.duplicates) messages.push(parsed.duplicates + '件の完全重複を除外しました。');
      if (source.overlaps) {
        messages.push('この記録元に時間帯が重なる記録が' + source.overlaps.toLocaleString() +
          '件あります。取り込み前に日別合計を確認してください。');
      }
      messages.push('保存時は既存の同日歩数を、選んだ日別合計で置き換えます。');
      if (source.energyDays) {
        messages.push('活動エネルギーのある日は、歩数からの換算ではなく実測値で採点します。');
      }
      note.textContent = messages.join(' ');
    }

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      parsed = null; save.disabled = true; wrap.hidden = true;
      if (!file) { status.textContent = ''; return; }
      status.textContent = '歩数を読み取っています…';
      var lastPct = -1;
      parseHealthFile(file, function (pct) {
        if (pct != null && pct !== lastPct) {
          lastPct = pct; status.textContent = '歩数を読み取っています… ' + pct + '%';
        }
      }).then(function (result) {
        parsed = result;
        select.innerHTML = result.sources.map(function (source, index) {
          return '<option value="' + index + '">' + A.esc(source.name) + '（' +
            source.days + '日・' + source.records.toLocaleString() + '件）</option>';
        }).join('');
        status.textContent = '読み取り完了';
        wrap.hidden = false; save.disabled = false;
        drawSource();
      }).catch(function (e) {
        status.textContent = '読み取れませんでした: ' + e.message;
      });
    });
    select.addEventListener('change', drawSource);
    save.addEventListener('click', function () {
      var source = selectedSource();
      if (!source) return;
      save.disabled = true; save.textContent = '保存中…';
      S.Body.importSteps(source.rows).then(function (count) {
        A.closeSheet();
        A.toast(count + '日分の歩数' +
          (source.energyDays ? 'と' + source.energyDays + '日分の活動エネルギー' : '') +
          'を取り込みました', 4000);
        A.render();
      }).catch(function (e) {
        save.disabled = false; save.textContent = 'この記録元から取り込む';
        A.toast('取り込めませんでした: ' + e.message);
      });
    });

  }

  function receiveUrl() {
    var url = new URL(global.location.href);
    if (!url.searchParams.has('steps')) return Promise.resolve(0);
    var text = url.searchParams.get('steps'), date = url.searchParams.get('date');
    return importText(text, date).then(function (count) {
      url.searchParams.delete('steps'); url.searchParams.delete('date');
      global.history.replaceState(global.history.state, '', url.pathname + url.search + url.hash);
      return count;
    });
  }

  global.Steps = {
    parse: parse, importText: importText, openImport: openImport, receiveUrl: receiveUrl,
    parseHealthFile: parseHealthFile, _zipExportEntry: zipExportEntry,
    _parseHealthXmlStream: parseHealthXmlStream
  };
})(window);
