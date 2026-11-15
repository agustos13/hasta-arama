/* Hasta Arama – Google girişi, Sheets/Drive erişimi ve arayüz */
(function () {
  'use strict';
  var C = window.HastaCore;

  // ---- AYAR: Google Cloud'da oluşturulan OAuth istemci kimliği ----------------
  var CLIENT_ID = '351276444427-76irpehjgjrndivhhi5qo9m0f3im6jov.apps.googleusercontent.com';
  // ---------------------------------------------------------------------------
  var SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
    'email'
  ].join(' ');
  var DATA_MAX_AGE = 15 * 60 * 1000;      // tablolar 15 dk'da bir yenilenir
  var LS = { tok: 'ha_token', hint: 'ha_hint', state: 'ha_state', folders: 'ha_folders' };

  var $ = function (id) { return document.getElementById(id); };
  var out = $('out'), input = $('q'), statusEl = $('status');
  var tables = null, loadedAt = 0, loading = null, reqId = 0, timer = null, copyTexts = [];

  /* ------------------------------ Kimlik ------------------------------ */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function getToken() {
    try { var t = JSON.parse(lsGet(LS.tok) || 'null'); return t && t.exp > Date.now() + 60000 ? t.v : null; } catch (e) { return null; }
  }
  function signIn(chooseAccount) {
    var state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    lsSet(LS.state, state);
    var p = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: location.origin + location.pathname,
      response_type: 'token',
      scope: SCOPES,
      include_granted_scopes: 'true',
      state: state
    });
    var hint = lsGet(LS.hint);
    if (chooseAccount || !hint) p.set('prompt', 'select_account');
    else p.set('login_hint', hint);
    location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
  }
  function signOut() {
    var t = getToken();
    if (t) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t), { method: 'POST' }).catch(function () {});
    lsDel(LS.tok); lsDel(LS.hint);
    tables = null; loadedAt = 0;
    showLogin('Çıkış yapıldı.');
  }
  /** Google'dan dönüşte adres satırındaki #access_token'ı alır. */
  function handleRedirect() {
    if (!location.hash || location.hash.length < 2) return null;
    var h = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    if (h.get('error')) return { error: h.get('error') };
    if (!h.get('access_token')) return null;
    if (h.get('state') !== lsGet(LS.state)) return { error: 'state' };
    lsDel(LS.state);
    var scope = h.get('scope') || '';
    lsSet(LS.tok, JSON.stringify({ v: h.get('access_token'), exp: Date.now() + (+h.get('expires_in') || 3600) * 1000 }));
    if (scope.indexOf('spreadsheets.readonly') === -1) return { error: 'scope_sheets' };
    if (scope.indexOf('drive.readonly') === -1) return { warn: 'scope_drive' };
    return { ok: true };
  }

  /* ------------------------------ API ------------------------------ */
  function AuthError() { this.auth = true; this.message = 'Oturum süresi doldu'; }
  function api(url) {
    var t = getToken();
    if (!t) return Promise.reject(new AuthError());
    return fetch(url, { headers: { Authorization: 'Bearer ' + t } }).then(function (r) {
      if (r.status === 401) { lsDel(LS.tok); throw new AuthError(); }
      if (r.status === 403 || r.status === 404) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          var e = new Error((j.error && j.error.message) || 'Erişim izni yok'); e.forbidden = true; throw e;
        });
      }
      if (!r.ok) throw new Error('Google API hatası (' + r.status + ')');
      return r.json();
    });
  }

  function loadData(force) {
    if (!force && tables && Date.now() - loadedAt < DATA_MAX_AGE) return Promise.resolve(tables);
    if (loading) return loading;
    var id = C.CONFIG.SPREADSHEET_ID, srcs = C.SOURCES.concat([C.PLANNED, C.POLI]);
    setStatus('Tablolar yükleniyor…');
    loading = api('https://sheets.googleapis.com/v4/spreadsheets/' + id + '?fields=sheets.properties(sheetId,title)')
      .then(function (meta) {
        var gid = {};
        (meta.sheets || []).forEach(function (s) { gid[s.properties.title] = s.properties.sheetId; });
        var qs = srcs.map(function (s) { return 'ranges=' + encodeURIComponent("'" + s.sheet + "'!A1:" + s.lastCol); }).join('&');
        return api('https://sheets.googleapis.com/v4/spreadsheets/' + id + '/values:batchGet?' + qs + '&valueRenderOption=FORMATTED_VALUE')
          .then(function (res) {
            var t = {};
            srcs.forEach(function (s, i) { t[s.code] = C.buildTable(s, (res.valueRanges[i] || {}).values, gid[s.sheet]); });
            tables = t; loadedAt = Date.now();
            showUpdated();
            return t;
          });
      })
      .catch(function (e) {
        if (e.forbidden) e.message = 'Hasta tablolarına erişim izniniz yok. Tablo sahibinden erişim isteyin.';
        throw e;
      })
      .then(function (t) { loading = null; return t; }, function (e) { loading = null; throw e; });
    return loading;
  }

  // Konsey klasörü: Drive araması + klasör soy ağacı kontrolü (klasör kimlikleri cihazda önbelleklenir)
  var folderMemo = {};
  try { folderMemo = JSON.parse(lsGet(LS.folders) || '{}'); } catch (e) {}
  var folderPromises = {};
  function underKonsey(id, depth) {
    if (id === C.CONFIG.KONSEY_FOLDER_ID) return Promise.resolve(true);
    if (folderMemo[id] !== undefined) return Promise.resolve(folderMemo[id]);
    if (depth > 6) return Promise.resolve(false);
    if (!folderPromises[id]) {
      folderPromises[id] = api('https://www.googleapis.com/drive/v3/files/' + id + '?fields=parents&supportsAllDrives=true')
        .then(function (f) { return f.parents && f.parents[0] ? underKonsey(f.parents[0], depth + 1) : false; })
        .catch(function (e) { if (e.auth) throw e; return false; })
        .then(function (v) { folderMemo[id] = v; lsSet(LS.folders, JSON.stringify(folderMemo)); return v; });
    }
    return folderPromises[id];
  }
  var konseyCache = {};
  function findKonsey(protocol, name, loose) {
    var p = C.digits(protocol), key = p + '|' + C.norm(name) + '|' + (loose ? 1 : 0);
    if (konseyCache[key]) return konseyCache[key];
    var q;
    if (p) q = "name contains '" + p + "'";
    else {
      var words = String(name || '').trim().split(/\s+/).filter(function (w) { return w.length > 1; });
      if (!words.length) return Promise.resolve([]);
      q = words.map(function (w) { return "name contains '" + w.replace(/\\/g, '').replace(/'/g, "\\'") + "'"; }).join(' and ');
    }
    var url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q + ' and trashed = false') +
      '&corpora=allDrives&includeItemsFromAllDrives=true&supportsAllDrives=true&pageSize=50&fields=' +
      encodeURIComponent('files(id,name,parents,webViewLink)');
    var pr = api(url).then(function (res) {
      var files = (res.files || []).filter(function (f) { return C.konseyAccept(f.name, protocol, name, loose); });
      return Promise.all(files.map(function (f) {
        return Promise.all((f.parents || []).map(function (pid) { return underKonsey(pid, 0); }))
          .then(function (ok) { return ok.some(Boolean) ? { name: f.name, url: f.webViewLink || ('https://drive.google.com/file/d/' + f.id + '/view') } : null; });
      }));
    }).then(function (list) { return list.filter(Boolean); })
      .catch(function (e) { if (e.auth) throw e; return []; });   // konsey klasörüne erişimi olmayan kullanıcı
    konseyCache[key] = pr;
    pr.catch(function () { delete konseyCache[key]; });
    return pr;
  }

  /* ------------------------------ Arayüz ------------------------------ */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function dash(s) { return String(s || '').trim() || '—'; }
  function setStatus(t) { statusEl.textContent = t || ''; }
  // "Son güncelleme bugün 14:35" / "Son güncelleme dün 23:50" / "Son güncelleme 12.11.2026 09:10"
  function showUpdated() {
    if (!loadedAt) return;
    var d = new Date(loadedAt), now = new Date();
    var day = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((day(now) - day(d)) / 86400000);
    var when = diff === 0 ? 'bugün' : diff === 1 ? 'dün' : d.toLocaleDateString('tr-TR');
    setStatus('Son güncelleme ' + when + ' ' + d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }));
  }
  // Uygulama arka planda kalıp gün değişirse yazı da güncellensin
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && loadedAt && statusEl.textContent.indexOf('Son güncelleme') === 0) showUpdated();
  });

  function showLogin(msg) {
    document.body.classList.add('signed-out');
    out.innerHTML = '<div class="card login"><div class="name">Hasta Arama</div>' +
      '<p class="lead">KUH/AH ameliyat, ameliyat planlama, poliklinik listeleri ve konsey dosyalarında arama.</p>' +
      (msg ? '<div class="warn">' + esc(msg) + '</div>' : '') +
      '<button id="signin" class="big">Google ile giriş yap</button>' +
      '<p class="small">Hasta tablolarına erişimi olan Google hesabınızı seçin. Veriler cihaza kaydedilmez.</p></div>';
    $('signin').onclick = function () { signIn(true); };
    setStatus('');
  }
  function showAuthNeeded() {
    out.innerHTML = '<div class="card"><p class="lead">Oturum süresi doldu.</p><button id="resume" class="big">Devam et</button></div>';
    $('resume').onclick = function () { signIn(false); };
  }
  function showError(e) {
    if (e && e.auth) return showAuthNeeded();
    out.innerHTML = '<div class="warn">' + esc(e && e.message || e) + '</div>';
  }

  function run() {
    var q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 2) { out.innerHTML = ''; return; }
    var my = ++reqId;
    out.innerHTML = '<div class="status"><div class="spinner"></div>Aranıyor…</div>';
    loadData(false)
      .then(function (t) { return C.search(q, t, findKonsey); })
      .then(function (res) { if (my === reqId) render(res, q); })
      .catch(function (e) { if (my === reqId) showError(e); });
  }

  function konseyHtml(list) {
    if (list === null) return '<span class="pill no">Aramayı daraltın</span>';
    if (!list.length) return '<span class="pill no">Yok</span>';
    return '<span class="pill yes">Var' + (list.length > 1 ? ' (' + list.length + ')' : '') + '</span><div class="files">' +
      list.map(function (f) { return '<a href="' + esc(f.url) + '" target="_blank" rel="noopener">📄 ' + esc(f.name) + '</a>'; }).join('') + '</div>';
  }
  function row(k, v, bold) {
    return '<div class="row"><div class="k">' + k + '</div><div class="v">' + (bold ? '<b>' : '') + esc(dash(v)) + (bold ? '</b>' : '') + '</div></div>';
  }
  function link(url, label) { return '<a class="rowlink" href="' + esc(url) + '" target="_blank" rel="noopener">Tabloda aç (' + label + ') ↗</a>'; }

  function render(res, q) {
    copyTexts = [];
    if (!res.patients.length) {
      var sug = res.suggestions || [];
      out.innerHTML = '<div class="card"><div class="name">“' + esc(q) + '”</div>' +
        '<p class="lead">KUH/AH ameliyat, ameliyat planlama ve poliklinik listelerinde kayıt bulunamadı.</p>' +
        (sug.length ? '<div class="sug"><div class="k">Bunu mu demek istediniz?</div>' + sug.map(function (s) {
          return '<button class="sugb" data-q="' + esc(s.name) + '">' + esc(s.name) + '<span>' + esc(s.where) + (s.proto ? ' · ' + esc(s.proto) : '') + '</span></button>';
        }).join('') + '</div>' : '') +
        '<div class="row"><div class="k">Konsey</div><div class="v">' + konseyHtml(res.konseyForQuery) + '</div></div></div>';
      return;
    }
    var html = res.total > 1 ? '<div class="count">' + res.total + ' hasta bulundu' +
      (res.total > res.patients.length ? ' – ilk ' + res.patients.length + ' gösteriliyor' : '') + '</div>' : '';
    if (res.mode === 'planned') html += '<div class="note">KUH/AH ameliyat listelerinde kayıt yok – <b>ameliyat planlama</b> listesinde bulundu.</div>';
    if (res.mode === 'poli') html += '<div class="note">Ameliyat ve ameliyat planlama listelerinde kayıt yok – <b>poliklinik</b> listesinde bulundu.</div>';

    res.patients.forEach(function (p, i) {
      var text = [];
      var protoTxt = p.protocols.map(function (x) { return (x.h ? x.h + ' ' : '') + x.p; }).join(' · ');
      html += '<section class="card"><div class="head"><div><div class="name">' + esc(p.name || '(ad yok)') + '</div>' +
        (protoTxt ? '<div class="proto">Protokol: ' + esc(protoTxt) + '</div>' : '') +
        '</div><button class="copy" data-i="' + i + '">Kopyala</button></div>';
      text.push(p.name + (protoTxt ? ' (' + protoTxt + ')' : ''));

      if (res.mode === 'surgery') {
        p.hospitalList.forEach(function (h) {
          var ops = h.ops, multi = ops.length > 1;
          html += '<div class="op">';
          if (!multi) {
            var o = ops[0], fut = C.isFuture(o.tarih);
            html += '<p class="lead">' + (fut ? 'Hastanın <b>' : 'Hasta <b>') + esc(h.code) + '</b>’ta <b>' + esc(dash(o.tarih)) + '</b> tarihinde ' +
              (fut ? 'ameliyatı planlanmıştır.' : 'ameliyat olmuştur.') + '</p>' +
              row('Tanı', o.tani) + row('Ameliyat', o.islem) + row('Doktor', o.doktor) + row('Özellikler', o.ozellik) + link(o.url, h.code + ' satır ' + o.row);
            text.push('', (fut ? 'Hastanın ' : 'Hasta ') + h.code + '\'ta ' + dash(o.tarih) + ' tarihinde ' + (fut ? 'ameliyatı planlanmıştır.' : 'ameliyat olmuştur.'),
              'Tanı: ' + dash(o.tani), 'Ameliyat: ' + dash(o.islem), 'Doktor: ' + dash(o.doktor), 'Özellikler: ' + dash(o.ozellik));
          } else {
            var nFut = ops.filter(function (op) { return C.isFuture(op.tarih); }).length, nPast = ops.length - nFut;
            var leadH, leadT;
            if (!nFut) {
              leadH = 'Hasta <b>' + esc(h.code) + '</b>’ta <b>' + ops.length + '</b> kere ameliyat olmuştur.';
              leadT = 'Hasta ' + h.code + '\'ta ' + ops.length + ' kere ameliyat olmuştur.';
            } else if (!nPast) {
              leadH = 'Hastanın <b>' + esc(h.code) + '</b>’ta <b>' + nFut + '</b> ameliyatı planlanmıştır.';
              leadT = 'Hastanın ' + h.code + '\'ta ' + nFut + ' ameliyatı planlanmıştır.';
            } else {
              leadH = 'Hasta <b>' + esc(h.code) + '</b>’ta <b>' + nPast + '</b> kere ameliyat olmuştur, <b>' + nFut + '</b> ameliyatı daha planlanmıştır.';
              leadT = 'Hasta ' + h.code + '\'ta ' + nPast + ' kere ameliyat olmuştur, ' + nFut + ' ameliyatı daha planlanmıştır.';
            }
            html += '<p class="lead">' + leadH + '</p>';
            text.push('', leadT);
            ops.forEach(function (op, n) {
              var f = C.isFuture(op.tarih);
              html += '<div class="sub"><div class="subn">' + (n + 1) + '.</div><div class="subb">' +
                row(f ? 'Planlanan tarih' : 'Tarih', op.tarih, true) + row('Tanı', op.tani) + row('Ameliyat', op.islem) + row('Doktor', op.doktor) + row('Özellikler', op.ozellik) +
                link(op.url, h.code + ' satır ' + op.row) + '</div></div>';
              text.push((n + 1) + ') ' + dash(op.tarih) + (f ? ' (planlanan)' : '') + ' – ' + dash(op.tani) + ' – ' + dash(op.islem) + ' – ' + dash(op.doktor) + ' – ' + dash(op.ozellik));
            });
          }
          html += '</div>';
        });
      } else {
        var L = p.latest, fields;
        if (res.mode === 'planned') {
          html += '<div class="op"><p class="lead">Hasta <b>ameliyat planlama</b> listesinde' +
            (p.count > 1 ? ' <b>' + p.count + '</b> kez kayıtlı (son kayıt gösteriliyor).' : ' kayıtlı.') + '</p>';
          text.push('', 'Ameliyat planlama listesinde' + (p.count > 1 ? ' ' + p.count + ' kez kayıtlı (son kayıt):' : ' kayıtlı:'));
          fields = [['Tarih', L.tarih, true], ['İsim', p.name], ['Tanı', L.tani], ['Planlanan ameliyat', L.planlanan],
                    ['Doktor', L.doktor], ['Kabul etti mi', L.kabul], ['Not', L.not]];
        } else {
          html += '<div class="op"><p class="lead">Hasta polikliniğe <b>' + p.count + '</b> kez gelmiştir. Son geliş:</p>';
          text.push('', 'Hasta polikliniğe ' + p.count + ' kez gelmiştir. Son geliş:');
          fields = [['Tarih', L.tarih, true], ['İsim', p.name], ['Doktor', L.doktor], ['Tanı', L.tani], ['İstenen', L.istenen],
                    ['Hasta sonuç', L.hastaSonuc], ['Doktor sonuç', L.doktorSonuc], ['Özellik', L.ozellik]];
        }
        fields.forEach(function (f) { html += row(f[0], f[1], f[2]); text.push(f[0] + ': ' + dash(f[1])); });
        html += link(L.url, (res.mode === 'planned' ? 'Ameliyat' : 'Poliklinik') + ' satır ' + L.row) + '</div>';
      }
      html += '<div class="op"><div class="row"><div class="k">Konsey sonucu</div><div class="v">' + konseyHtml(p.konsey) + '</div></div></div>';
      var k = p.konsey || [];
      text.push('', 'Konsey sonucu: ' + (k.length ? 'Var' + (k.length > 1 ? ' (' + k.length + ')' : '') : 'Yok'));
      k.forEach(function (f) { text.push(f.name + ': ' + f.url); });
      if (res.mode === 'surgery' && p.postOp) {
        var P = p.postOp.latest;
        html += '<div class="op"><p class="lead">Hasta ameliyattan sonra polikliniğe <b>' + p.postOp.count + '</b> kez gelmiştir. Son geliş:</p>';
        text.push('', 'Hasta ameliyattan sonra polikliniğe ' + p.postOp.count + ' kez gelmiştir. Son geliş:');
        [['Tarih', P.tarih, true], ['Doktor', P.doktor], ['Tanı', P.tani], ['İstenen', P.istenen],
         ['Hasta sonuç', P.hastaSonuc], ['Doktor sonuç', P.doktorSonuc], ['Özellik', P.ozellik]].forEach(function (f) {
          html += row(f[0], f[1], f[2]); text.push(f[0] + ': ' + dash(f[1]));
        });
        html += link(P.url, 'Poliklinik satır ' + P.row) + '</div>';
      }
      html += '</section>';
      copyTexts.push(text.join('\n'));
    });
    out.innerHTML = html;
  }

  out.addEventListener('click', function (e) {
    var sb = e.target.closest('.sugb');
    if (sb) { input.value = sb.dataset.q; run(); return; }
    var b = e.target.closest('.copy'); if (!b) return;
    var t = copyTexts[+b.dataset.i];
    var done = function () { b.textContent = 'Kopyalandı ✓'; setTimeout(function () { b.textContent = 'Kopyala'; }, 1500); };
    var fallback = function () {
      var ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (x) {} ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, fallback); else fallback();
  });
  $('f').addEventListener('submit', function (e) { e.preventDefault(); input.blur(); run(); });
  input.addEventListener('input', function () {
    clearTimeout(timer);
    if (input.value.trim().length >= 3) timer = setTimeout(run, 500);
    else if (!input.value.trim()) { reqId++; out.innerHTML = ''; }
  });
  var panel = $('panel');
  $('menu').addEventListener('click', function (e) { e.stopPropagation(); panel.classList.toggle('open'); });
  document.addEventListener('click', function () { panel.classList.remove('open'); });
  panel.addEventListener('click', function (e) {
    var act = e.target.dataset.act; if (!act) return;
    panel.classList.remove('open');
    if (act === 'refresh') { konseyCache = {}; loadData(true).then(function () { if (input.value.trim()) run(); }, showError); }
    else if (act === 'switch') signIn(true);
    else if (act === 'logout') signOut();
  });

  /* ------------------------------ Açılış ------------------------------ */
  function start() {
    var r = handleRedirect();
    if (r && r.error === 'scope_sheets') return showLogin('Tablolara erişim izni verilmedi. Girişte tüm izinleri işaretleyin.');
    if (r && r.error) return showLogin(r.error === 'access_denied' ? 'Giriş iptal edildi.' : 'Giriş tamamlanamadı (' + r.error + ').');
    if (!getToken()) {
      // Daha önce giriş yapıldıysa otomatik yenile (bir kez), yoksa giriş ekranı
      if (lsGet(LS.hint) && !(r && r.error) && !sessionStorage.getItem('ha_tried')) {
        sessionStorage.setItem('ha_tried', '1');
        return signIn(false);
      }
      return showLogin();
    }
    sessionStorage.removeItem('ha_tried');
    document.body.classList.remove('signed-out');
    if (r && r.warn === 'scope_drive') setStatus('Konsey klasörü izni verilmedi – konsey dosyaları gösterilmeyecek.');
    if (!lsGet(LS.hint)) {
      api('https://www.googleapis.com/oauth2/v3/userinfo').then(function (u) { if (u.email) lsSet(LS.hint, u.email); }).catch(function () {});
    }
    out.innerHTML = '';   // ilk yükleme durumu üstteki satırda ("Tablolar yükleniyor…") gösteriliyor
    loadData(false).then(function () { if (!out.innerHTML) input.focus(); }, showError);
  }
  if (navigator.serviceWorker) navigator.serviceWorker.register('sw.js').catch(function () {});
  start();
})();
