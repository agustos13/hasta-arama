/* Hasta Arama – arama mantığı (tarayıcıda ve testte ortak) */
(function (root) {
  'use strict';

  // ---- AYARLAR ------------------------------------------------------------
  var CONFIG = {
    SPREADSHEET_ID: '1-GRx-Lf4lWPpfer7098auEZy-mm2Y4iY8ZyfOP1GjmY',
    KONSEY_FOLDER_ID: '1tDhT7QsSEtBEfBK700xZxMDJlr1txscj',
    MAX_PATIENTS: 20,
    KONSEY_LOOKUP_LIMIT: 8
  };
  // Ameliyat kayıtları: her hastane bir kaynak. Sütun: başlık adı ya da BÜYÜK harf (ör. 'D').
  var SOURCES = [
    { code: 'KUH', sheet: 'KUH', lastCol: 'M',
      cols: { tarih: 'tarih', protokol: 'protokol', ad: 'adı soyadı', tani: 'tanı', islem: 'işlem', doktor: 'isim', ozellik: 'Özellikler' } },
    { code: 'AH', sheet: 'AH', lastCol: 'L',
      cols: { tarih: 'B', protokol: 'C', ad: 'D', tani: 'E', islem: 'F', doktor: 'H', ozellik: 'L' } }
  ];
  var PLANNED = { code: 'PLAN', sheet: 'Ameliyat', lastCol: 'M',
    cols: { tarih: 'B', protokol: 'C', ad: 'D', doktor: 'E', tani: 'G', planlanan: 'H', kabul: 'J', not: 'M' } };
  var POLI = { code: 'POL', sheet: 'Poliklinik', lastCol: 'L',
    cols: { tarih: 'B', protokol: 'C', ad: 'D', doktor: 'E', tani: 'H', istenen: 'I', hastaSonuc: 'J', doktorSonuc: 'K', ozellik: 'L' } };
  // Aynı ad soyadlı farklı hastalar: önce protokol, yoksa tarih ('until' dahil) ile ayrılır.
  var NAMESAKES = {
    'hasan eker': [
      { label: '#1', protocols: ['204020780'], until: '31.12.2017' },
      { label: '#2', protocols: ['204271585', '31453578'] }
    ]
  };
  // -------------------------------------------------------------------------

  function norm(s) {
    return String(s || '')
      .replace(/[İIı]/g, 'i').toLowerCase()
      .replace(/ğ/g, 'g').replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ö/g, 'o').replace(/ü/g, 'u')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ').trim();
  }
  function digits(s) { return String(s || '').replace(/\D/g, '').replace(/^0+/, ''); }

  function colIndex(headers, ref, sheet) {
    if (/^[A-Z]{1,2}$/.test(ref)) {
      var n = 0;
      ref.split('').forEach(function (ch) { n = n * 26 + ch.charCodeAt(0) - 64; });
      return n - 1;
    }
    var t = norm(ref);
    for (var i = 0; i < headers.length; i++) if (norm(headers[i]) === t) return i;
    throw new Error(sheet + ' sekmesinde "' + ref + '" sütunu bulunamadı');
  }

  /** Sheets API'den gelen değerleri (başlık 1. satır) kayıtlara çevirir. */
  function buildTable(src, values, gid) {
    values = values || [];
    var headers = values[0] || [];
    var c = {};
    Object.keys(src.cols).forEach(function (k) { c[k] = colIndex(headers, src.cols[k], src.sheet); });
    var base = 'https://docs.google.com/spreadsheets/d/' + CONFIG.SPREADSHEET_ID + '/edit#gid=' + gid + '&range=A';
    var rows = [];
    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      var name = String(row[c.ad] || '').replace(/\s+/g, ' ').trim();
      var proto = String(row[c.protokol] || '').trim();
      if (!name && !proto) continue;
      var rec = { row: i + 1, url: base + (i + 1) };
      Object.keys(c).forEach(function (k) { if (k !== 'ad' && k !== 'protokol') rec[k] = row[c[k]] || ''; });
      rows.push({ name: name, nn: norm(name), proto: proto, pd: digits(proto), rec: rec });
    }
    return { code: src.code, rows: rows };
  }

  function parseDate(s) {
    var m = String(s || '').trim().match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/);
    if (m) { var y = +m[3]; if (y < 100) y += 2000; return new Date(y, +m[2] - 1, +m[1]).getTime(); }
    m = String(s || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : NaN;
  }

  /** Tarih bugünden sonra mı (planlanmış ameliyat)? */
  function isFuture(s) {
    var t = parseDate(s), now = new Date();
    return !isNaN(t) && t > new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }

  var NAMESAKES_N = null;
  function splitOf(x) {
    if (!NAMESAKES_N) { NAMESAKES_N = {}; Object.keys(NAMESAKES).forEach(function (k) { NAMESAKES_N[norm(k)] = NAMESAKES[k]; }); }
    var r = NAMESAKES_N[x.nn];
    if (!r) return null;
    for (var k = 0; k < r.length; k++) {
      if (x.pd && (r[k].protocols || []).some(function (p) { return digits(p) === x.pd; })) return { idx: k, label: r[k].label };
    }
    var t = parseDate(x.rec.tarih);
    for (var i = 0; i < r.length; i++) {
      if (!r[i].until || (!isNaN(t) && t <= parseDate(r[i].until))) return { idx: i, label: r[i].label };
    }
    return { idx: r.length - 1, label: r[r.length - 1].label };
  }

  function wordPrefixMatch(nn, tokens) {
    var words = nn.split(' ');
    return tokens.every(function (tk) { return words.some(function (w) { return w.indexOf(tk) === 0; }); });
  }
  function protoHit(x, m) {
    return x.pd !== '' && (x.pd === m.qd || (m.compact.length >= 6 && x.pd.indexOf(m.compact) !== -1));
  }

  function groupMatches(tables, m, idNames) {
    var groups = {}, order = [], top = '';
    if (m.isProtocol) {
      var n = 0;
      Object.keys(idNames).forEach(function (k) { if (idNames[k] > n) { top = k; n = idNames[k]; } });
    }
    function add(key, t, x) {
      var sp = key.indexOf('N:') === 0 ? splitOf(x) : null;
      if (sp) key += '|' + sp.idx;
      if (!groups[key]) {
        groups[key] = { name: '', nameCounts: {}, protocols: [], items: {}, label: sp ? sp.label : '', hit: false,
                        splitNn: sp ? x.nn : '', splitIdx: sp ? sp.idx : -1, nns: {} };
        order.push(key);
      }
      var g = groups[key];
      if (m.isProtocol && protoHit(x, m)) g.hit = true;
      if (x.nn.length >= 3) { g.nameCounts[x.name] = (g.nameCounts[x.name] || 0) + 1; g.nns[x.nn] = 1; }
      if (x.proto && x.pd && !g.protocols.some(function (p) { return p.h === t.code && p.p === x.proto; })) g.protocols.push({ h: t.code, p: x.proto });
      (g.items[t.code] = g.items[t.code] || []).push(x.rec);
    }
    tables.forEach(function (t) {
      t.rows.forEach(function (x) {
        var key = null;
        if (m.isProtocol) {
          if (x.nn.length >= 3 && idNames[x.nn]) key = 'N:' + x.nn;
          else if (protoHit(x, m)) key = top ? 'N:' + top : 'P:' + x.pd;
        } else if (x.nn.length >= 3 && wordPrefixMatch(x.nn, m.tokens)) {
          key = 'N:' + x.nn;
        }
        if (key) add(key, t, x);
      });
    });
    if (m.isProtocol) order = order.filter(function (k) { return !groups[k].label || groups[k].hit; });
    order.forEach(function (k) {
      var g = groups[k], best = '', c = 0;
      delete g.hit;
      Object.keys(g.nameCounts).forEach(function (nm) { if (g.nameCounts[nm] > c) { best = nm; c = g.nameCounts[nm]; } });
      g.name = best + (g.label ? ' ' + g.label : '');
      delete g.nameCounts;
    });
    return { groups: groups, order: order };
  }

  function latest(list) {
    var best = null, bestT = -Infinity;
    list.forEach(function (x) {
      var t = parseDate(x.tarih), score = isNaN(t) ? -Infinity : t;
      if (best === null || score > bestT || (score === bestT && x.row > best.row)) { best = x; bestT = score; }
    });
    return best;
  }

  function lev(a, b) {
    var prev = [], pp = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], pp[j - 2] + 1);
      }
      pp = prev; prev = cur;
    }
    return prev[b.length];
  }

  function suggest(tables, tokens) {
    if (!tokens.length) return [];
    var seen = {}, out = [];
    tables.forEach(function (t) {
      t.rows.forEach(function (x) {
        if (x.nn.length < 3 || seen[x.nn] !== undefined) return;
        var words = x.nn.split(' '), total = 0, ok = true;
        for (var i = 0; i < tokens.length && ok; i++) {
          var tk = tokens[i], allowed = tk.length <= 2 ? 0 : tk.length <= 4 ? 1 : tk.length <= 7 ? 2 : 3, best = 99;
          for (var j = 0; j < words.length; j++) {
            var w = words[j];
            var d = w.indexOf(tk) === 0 ? 0 : lev(tk, w.length > tk.length + 2 ? w.slice(0, tk.length + 1) : w);
            if (d < best) best = d;
          }
          if (best > allowed) ok = false; else total += best;
        }
        seen[x.nn] = ok ? total : -1;
        if (ok) out.push({ name: x.name, score: total, where: t.code, proto: x.proto });
      });
    });
    out.sort(function (a, b) { return a.score - b.score; });
    var WHERE = { KUH: 'KUH', AH: 'AH', PLAN: 'Ameliyat planlama', POL: 'Poliklinik' };
    return out.slice(0, 6).map(function (s) { return { name: s.name, proto: s.proto, where: WHERE[s.where] }; });
  }

  /**
   * Ana arama. tables = { KUH, AH, PLAN, POL } (buildTable çıktıları).
   * findKonsey(protocol, name, loose) → Promise<[{name,url}]> dışarıdan verilir (Drive API).
   */
  function search(query, tables, findKonsey) {
    var q = String(query || '').trim();
    if (q.length < 2) return Promise.resolve({ mode: 'none', patients: [], konseyForQuery: [] });
    var compact = q.replace(/[\s\-\/.]/g, '');
    var m = { isProtocol: /^\d+$/.test(compact), compact: compact, qd: compact.replace(/^0+/, ''), tokens: norm(q).split(' ').filter(String) };
    var surgery = SOURCES.map(function (s) { return tables[s.code]; });
    var all = surgery.concat([tables.PLAN, tables.POL]);

    var idNames = null;
    if (m.isProtocol) {
      idNames = {};
      all.forEach(function (t) { t.rows.forEach(function (x) { if (protoHit(x, m) && x.nn.length >= 3) idNames[x.nn] = (idNames[x.nn] || 0) + 1; }); });
    }
    var extra = m.isProtocol ? compact : '';

    var r = groupMatches(surgery, m, idNames);
    if (r.order.length) {
      return finish(r, function (g) {
        g.hospitalList = SOURCES.filter(function (s) { return g.items[s.code]; }).map(function (s) { return { code: s.code, ops: g.items[s.code] }; });
        g.postOp = postOpVisits(g, tables.POL);
      }, extra, findKonsey).then(function (p) { return { mode: 'surgery', patients: p, total: r.order.length }; });
    }
    r = groupMatches([tables.PLAN], m, idNames);
    if (r.order.length) {
      return finish(r, function (g) { var l = g.items.PLAN; g.count = l.length; g.latest = latest(l); }, extra, findKonsey)
        .then(function (p) { return { mode: 'planned', patients: p, total: r.order.length }; });
    }
    r = groupMatches([tables.POL], m, idNames);
    if (r.order.length) {
      return finish(r, function (g) { var l = g.items.POL; g.count = l.length; g.latest = latest(l); }, extra, findKonsey)
        .then(function (p) { return { mode: 'poli', patients: p, total: r.order.length }; });
    }
    return findKonsey(m.isProtocol ? compact : '', m.isProtocol ? '' : q, true).then(function (k) {
      return { mode: 'none', patients: [], total: 0, konseyForQuery: k, suggestions: m.isProtocol ? [] : suggest(all, m.tokens) };
    });
  }

  /** Ameliyat olan hastanın, son ameliyat tarihinden SONRAKİ poliklinik gelişleri (protokol veya aynı isim). */
  function postOpVisits(g, polTable) {
    var lastOp = -Infinity;
    g.hospitalList.forEach(function (h) { h.ops.forEach(function (o) { var t = parseDate(o.tarih); if (!isNaN(t) && !isFuture(o.tarih) && t > lastOp) lastOp = t; }); });
    if (lastOp === -Infinity || !polTable) return null;
    var protos = {};
    g.protocols.forEach(function (p) { var d = digits(p.p); if (d) protos[d] = 1; });
    var list = polTable.rows.filter(function (x) {
      var mine = (x.pd && protos[x.pd]) || (x.nn.length >= 3 && g.nns[x.nn]);
      if (!mine) return false;
      if (g.splitIdx >= 0 && x.nn === g.splitNn && splitOf(x).idx !== g.splitIdx) return false;
      var t = parseDate(x.rec.tarih);
      return !isNaN(t) && t > lastOp;
    }).map(function (x) { return x.rec; });
    return list.length ? { count: list.length, latest: latest(list) } : null;
  }

  function finish(r, shape, extraProto, findKonsey) {
    return Promise.all(r.order.slice(0, CONFIG.MAX_PATIENTS).map(function (k, idx) {
      var g = r.groups[k];
      shape(g);
      delete g.items;
      if (extraProto && !g.protocols.some(function (p) { return digits(p.p) === digits(extraProto); })) g.protocols.unshift({ h: '', p: extraProto });
      g.protocols.forEach(function (p) { if (p.h === 'PLAN' || p.h === 'POL') p.h = ''; });
      var splitNn = g.splitNn, splitIdx = g.splitIdx;
      delete g.splitNn; delete g.splitIdx; delete g.nns;
      if (idx >= CONFIG.KONSEY_LOOKUP_LIMIT) { g.konsey = null; return Promise.resolve(g); }
      var jobs = g.protocols.map(function (p) { return findKonsey(p.p, ''); });
      jobs.push(findKonsey('', g.name.replace(/\s*#\d+\s*$/, '')).then(function (byName) {
        if (!g.label) return byName;
        var mine = g.protocols.map(function (p) { return digits(p.p); });
        return byName.filter(function (f) {
          var mm = f.name.match(/\((\d{5,})\)/);
          if (mm) return mine.indexOf(digits(mm[1])) !== -1;
          var dm = f.name.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
          if (dm) return splitOf({ nn: splitNn, pd: '', rec: { tarih: dm[1] } }).idx === splitIdx;
          return true;
        });
      }));
      return Promise.all(jobs).then(function (lists) {
        var seen = {}, konsey = [];
        lists.forEach(function (l) { l.forEach(function (f) { if (!seen[f.url]) { seen[f.url] = 1; konsey.push(f); } }); });
        g.konsey = konsey;
        return g;
      });
    }));
  }

  /** Konsey dosya adı eşleştirme (Drive sonuçları üzerinde). */
  function konseyAccept(fname, protocol, name, loose) {
    var p = digits(protocol);
    if (p) { var m = fname.match(/\((\d+)\)/); return !!m && digits(m[1]) === p; }
    var nn = norm(name);
    var fn = norm(fname.replace(/\.[^.]+$/, '').replace(/\([^)]*\)/g, ''));
    return loose ? nn.split(' ').every(function (t) { return fn.indexOf(t) !== -1; }) : fn === nn;
  }

  root.HastaCore = {
    CONFIG: CONFIG, SOURCES: SOURCES, PLANNED: PLANNED, POLI: POLI,
    norm: norm, digits: digits, isFuture: isFuture, buildTable: buildTable, search: search, konseyAccept: konseyAccept
  };
})(typeof window !== 'undefined' ? window : globalThis);
