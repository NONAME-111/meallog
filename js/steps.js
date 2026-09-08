/* steps.js - Apple Health書き出しZIP/XMLと手入力から日別歩数を取り込む。 */
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
    if (!parts.length || parts.length > 366) throw new Error('日付と歩数を1日ずつ、366日以内で入力してください');
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

  function healthCollector() {
    var maps = Object.create(null), meta = Object.create(null), seen = new Set();
    var recordCount = 0, duplicateCount = 0;
    function add(tag) {
      if (tag.indexOf('HKQuantityTypeIdentifierStepCount') === -1) return;
      var a = attributes(tag);
      if (a.type !== 'HKQuantityTypeIdentifierStepCount' || a.unit !== 'count') return;
      var value = Number(a.value), date = String(a.startDate || '').slice(0, 10);
      if (!isFinite(value) || value < 0 || !validDate(date)) return;
      var source = a.sourceName || '記録元不明';
      var key = [source, a.startDate || '', a.endDate || '', value].join('\u0001');
      if (seen.has(key)) { duplicateCount++; return; }
      seen.add(key);
      if (!maps[source]) { maps[source] = Object.create(null); meta[source] = { records: 0 }; }
      maps[source][date] = (maps[source][date] || 0) + value;
      meta[source].records++;
      recordCount++;
    }
    function finish() {
      var sources = Object.keys(maps).map(function (name) {
        var rows = Object.keys(maps[name]).sort().map(function (date) {
          return { date: date, steps: Math.max(0, Math.round(maps[name][date])) };
        });
        return {
          name: name, records: meta[name].records, days: rows.length, rows: rows,
          from: rows.length ? rows[0].date : '', to: rows.length ? rows[rows.length - 1].date : '',
          total: rows.reduce(function (sum, row) { return sum + row.steps; }, 0)
        };
      }).sort(function (a, b) { return b.days - a.days || b.records - a.records; });
      if (!sources.length) throw new Error('歩数データが見つかりませんでした');
      return { sources: sources, records: recordCount, duplicates: duplicateCount };
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
    var body = A.openSheet('歩数を取り込む',
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
      '<button class="btn wide" id="healthSave" disabled>この歩数を取り込む</button>' +
      '<p class="tiny muted">ZIPは外部へ送らず、この端末内だけで読み取ります。同じ日の歩数は加算せず、選んだ記録元の最新合計へ置き換えます。</p>' +
      '<details class="step-shortcut"><summary>1日分を数字で入力する場合</summary>' +
      '<label class="fld"><span>日付と歩数</span><textarea id="stepsText" rows="4" placeholder="2026-09-08:8432">' +
      A.esc(initial || '') + '</textarea></label>' +
      '<p class="small muted" id="stepsPreview" aria-live="polite"></p>' +
      '<button class="btn sub wide" id="stepsSave" disabled>入力した歩数を取り込む</button></details>');

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
        A.esc(source.records.toLocaleString() + '件の記録') + '</span>';
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
        note.textContent = result.sources.length > 1
          ? '記録元が複数あります。iPhoneとApple Watchを同時に合算すると重複するため、1つ選んで取り込みます。'
          : (result.duplicates ? result.duplicates + '件の完全重複を除外しました。' : '記録元は1つです。');
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
        A.closeSheet(); A.toast(count + '日分の歩数を取り込みました', 4000); A.render();
      }).catch(function (e) {
        save.disabled = false; save.textContent = 'この歩数を取り込む';
        A.toast('取り込めませんでした: ' + e.message);
      });
    });

    var input = body.querySelector('#stepsText'), textSave = body.querySelector('#stepsSave');
    function textPreview() {
      try {
        var rows = parse(input.value);
        body.querySelector('#stepsPreview').textContent = rows.length + '日分 (' + rows[0].date + ' ～ ' + rows[rows.length - 1].date + ')';
        textSave.disabled = false;
      } catch (e) {
        body.querySelector('#stepsPreview').textContent = input.value.trim() ? e.message : '';
        textSave.disabled = true;
      }
    }
    input.addEventListener('input', textPreview);
    textSave.addEventListener('click', function () {
      textSave.disabled = true;
      importText(input.value).then(function (n) {
        A.closeSheet(); A.toast(n + '日分の歩数を取り込みました'); A.render();
      }).catch(function (e) { A.toast('取り込めませんでした: ' + e.message); textPreview(); });
    });
    textPreview();
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
