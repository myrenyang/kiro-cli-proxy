'use strict';

// Static assets for the /proxy/data page. They are served as separate files
// (/proxy/ui.js, /proxy/ui.css) so the page can run under a strict CSP with no
// inline script or style. All dynamic content is inserted with textContent,
// never innerHTML, because captured bodies are untrusted.

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>kiro-cli-proxy data</title>
<link rel="stylesheet" href="/proxy/ui.css">
</head>
<body>
<header>
  <h2>kiro-cli-proxy</h2>
  <label>load <select id="limit"><option>8</option><option>20</option><option>50</option><option selected>100</option></select> rows</label>
  <label><input type="checkbox" id="tunnels" checked> show tunnels</label>
  <label><input type="checkbox" id="telemetry"> show telemetry</label>
  <label><input type="checkbox" id="auto" checked> auto-refresh</label>
  <button id="refresh" type="button">Refresh</button>
  <span id="status" class="muted"></span>
  <span id="learned" class="flag-note" title="These hosts were decrypted at first, but a client rejected the proxy's certificate, so they are now relayed without decryption (see LEARN_TUNNELS in the README)."></span>
</header>
<div class="table-wrap" id="tablewrap">
<table>
  <thead><tr id="head"></tr></thead>
  <tbody id="rows"></tbody>
</table>
</div>
<div class="panels">
  <div class="panel"><h3>Request</h3><div id="req"><span class="placeholder">select a row</span></div></div>
  <div class="panel"><h3>Response</h3><div id="res"><span class="placeholder">select a row</span></div></div>
</div>
<script src="/proxy/ui.js"></script>
</body>
</html>
`;

const css = `:root{color-scheme:dark;--row-h:32px;--visible-rows:8}
body{font-family:monospace;font-size:.9rem;padding:1rem;background:#1e1e1e;color:#d4d4d4}
header{display:flex;gap:1rem;align-items:center;flex-wrap:wrap;margin-bottom:.75rem}
h2{color:#ccc;margin:0}
.muted{color:#888}
.table-wrap{box-sizing:border-box;height:calc(var(--row-h) * (var(--visible-rows) + 1) + 2px);overflow-y:auto;overflow-x:auto;border:1px solid #444;background:#1e1e1e}
table{border-collapse:separate;border-spacing:0;width:100%}
th,td{box-sizing:border-box;height:var(--row-h);padding:0 8px;border-right:1px solid #444;border-bottom:1px solid #444;text-align:left;white-space:nowrap;overflow:hidden}
thead th{position:sticky;top:0;z-index:1;background:#2d2d2d;color:#9cdcfe}
tr{background:#1e1e1e}tr:hover{background:#252525}tr.active{background:#2a2a1a}
tr.muted td{color:#777}
.flag{margin-right:.5rem}
.flag-note{color:#d7ba7d}
.flag-reset{color:#8a8a8a;font-style:italic}
.flag-error{color:#f48771;font-weight:bold}
button,select{background:#3a3a3a;color:#d4d4d4;border:1px solid #555;padding:2px 8px;cursor:pointer;border-radius:3px;font-family:inherit}
td button{padding:0 8px;line-height:1.5}
button:hover{background:#4a4a4a}button:disabled{opacity:.4;cursor:default}
.panels{display:flex;gap:1rem;margin-top:1rem}
.panel{flex:1;border:1px solid #444;padding:.5rem;border-radius:4px;overflow:auto;max-height:65vh;background:#252526;min-width:0}
.panel h3{margin:0 0 .25rem;font-size:1rem;color:#9cdcfe}
h4{margin:.6rem 0 .25rem;font-size:.85rem;color:#9cdcfe}
.placeholder{color:#666;font-style:italic}
.note{color:#d7ba7d;font-size:.8rem}
pre.text{white-space:pre-wrap;word-break:break-word;margin:.25rem 0;background:#1e1e1e;padding:.4rem;border:1px solid #333;border-radius:3px}
details{margin-left:1rem}
details>summary{cursor:pointer;color:#d4d4d4}
.tree{margin-left:-1rem}
.k{color:#9cdcfe}.s{color:#ce9178;white-space:pre-wrap;word-break:break-word}.n{color:#b5cea8}.b{color:#569cd6}.z{color:#808080}
.leaf{margin-left:1rem}
`;

const js = `(function () {
  'use strict';
  var COLS = ['id', 'time', 'category', 'host', 'operation', 'status', 'ttfb_ms', 'duration_ms', 'req_bytes', 'res_bytes', 'conversation', 'model_id', 'history', 'tools', 'flags', 'details'];
  var $ = function (id) { return document.getElementById(id); };
  var activeId = null;
  var firstRender = true;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  // ---- JSON tree viewer (DOM nodes and textContent only) -------------------
  function leaf(v) {
    if (v === null) return el('span', 'z', 'null');
    if (typeof v === 'string') return el('span', 's', JSON.stringify(v));
    if (typeof v === 'number') return el('span', 'n', String(v));
    return el('span', 'b', String(v));
  }
  function tree(key, v, depth, openDepth) {
    if (v !== null && typeof v === 'object') {
      var isArr = Array.isArray(v);
      var keys = Object.keys(v);
      var d = el('details');
      if (depth < openDepth) d.open = true;
      var s = el('summary');
      if (key !== null) { s.appendChild(el('span', 'k', key + ': ')); }
      s.appendChild(document.createTextNode(isArr ? 'Array(' + keys.length + ')' : '{' + keys.length + '}'));
      d.appendChild(s);
      keys.forEach(function (k) { d.appendChild(tree(k, v[k], depth + 1, openDepth)); });
      return d;
    }
    var row = el('div', 'leaf');
    if (key !== null) row.appendChild(el('span', 'k', key + ': '));
    row.appendChild(leaf(v));
    return row;
  }
  function treeRoot(v, openDepth) {
    var wrap = el('div', 'tree');
    wrap.appendChild(tree(null, v, 0, openDepth));
    return wrap;
  }

  // ---- body rendering ------------------------------------------------------
  function renderBody(parent, body) {
    if (!body || body.format === 'empty') { parent.appendChild(el('span', 'placeholder', 'empty')); return; }
    if (body.note) parent.appendChild(el('div', 'note', body.note));
    if (body.format === 'eventstream') {
      parent.appendChild(el('h4', null, 'Assistant text'));
      parent.appendChild(el('pre', 'text', body.data.text || '(none)'));
      parent.appendChild(el('h4', null, 'Events (' + body.data.events.length + ')'));
      parent.appendChild(treeRoot(body.data.events, 1));
    } else if (body.format === 'json') {
      parent.appendChild(treeRoot(body.data, 2));
    } else if (body.format === 'text') {
      parent.appendChild(el('pre', 'text', body.data));
    } else {
      parent.appendChild(el('div', null, body.data.bytes + ' bytes, hex preview:'));
      parent.appendChild(el('pre', 'text', body.data.hexPreview));
    }
  }
  function renderSide(target, side, summary) {
    target.textContent = '';
    if (summary) {
      target.appendChild(el('h4', null, 'Summary'));
      target.appendChild(treeRoot(summary, 1));
    }
    target.appendChild(el('h4', null, 'Headers'));
    target.appendChild(side.headers ? treeRoot(side.headers, 0) : el('span', 'placeholder', 'none'));
    target.appendChild(el('h4', null, 'Body'));
    renderBody(target, side.body);
  }

  // ---- table ---------------------------------------------------------------
  function fmtTime(ms) {
    var d = new Date(ms), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  // One span per flag. A routine reset of an open tunnel is muted; a real error is red.
  // The raw error code is in the tooltip.
  function flagsCell(tr, r) {
    var td = el('td');
    function add(text, cls, title) {
      var s = el('span', 'flag ' + cls, text);
      if (title) s.title = title;
      td.appendChild(s);
    }
    if (r.req_truncated) add('req-trunc', 'flag-note');
    if (r.res_truncated) add('res-trunc', 'flag-note');
    if (r.aborted) add('aborted', 'flag-note');
    if (r.error_kind === 'reset') add('reset', 'flag-reset', r.error + ' (connection reset by the remote end after the tunnel was established)');
    else if (r.error) add('error', 'flag-error', r.error);
    tr.appendChild(td);
  }
  function cell(tr, text) { tr.appendChild(el('td', null, text === null || text === undefined ? '' : String(text))); }

  // The table area is exactly header + 8 rows tall (see --visible-rows in the CSS).
  // When the table is wider than the window, a horizontal scrollbar appears inside
  // that area and would eat into the 8th row, so add its measured thickness.
  function fitTableHeight() {
    var wrap = $('tablewrap');
    wrap.style.height = '';
    var bar = wrap.offsetHeight - wrap.clientHeight - 2; // 2 = top and bottom border
    if (bar > 0) wrap.style.height = 'calc(var(--row-h) * (var(--visible-rows) + 1) + 2px + ' + bar + 'px)';
  }

  function renderRows(rows) {
    var tbody = $('rows');
    var wrap = $('tablewrap');
    // Oldest first, newest last. The API returns newest first so that "load N rows" keeps the latest N.
    rows = rows.slice().reverse();
    // Follow new rows while the user is at the bottom (or on the first render);
    // otherwise keep whatever they scrolled to across auto-refresh.
    var wasAtBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 4;
    var scrollTop = wrap.scrollTop;
    tbody.textContent = '';
    rows.forEach(function (r) {
      // Blind tunnels and telemetry rows are both greyed (muted); telemetry is low-signal
      // even when it is decrypted.
      var muted = r.kind === 'tunnel' || r.category === 'telemetry';
      var tr = el('tr', muted ? 'muted' : '');
      tr.id = 'row-' + r.id;
      if (r.id === activeId) tr.classList.add('active');
      cell(tr, r.id);
      cell(tr, fmtTime(r.ts));
      cell(tr, r.category);
      cell(tr, r.host + (r.port && r.port !== 443 ? ':' + r.port : ''));
      cell(tr, r.kind === 'tunnel' ? '(tunnel)' : r.operation || r.path);
      cell(tr, r.status);
      cell(tr, r.ttfb_ms);
      cell(tr, r.duration_ms);
      cell(tr, r.req_bytes);
      cell(tr, r.res_bytes);
      cell(tr, r.conversation_id ? r.conversation_id.slice(0, 8) : '');
      cell(tr, r.model_id);
      cell(tr, r.history_count);
      cell(tr, r.tools_count);
      flagsCell(tr, r);
      var td = el('td');
      if (r.kind === 'mitm') {
        var b = el('button', null, 'Show');
        b.type = 'button';
        b.addEventListener('click', function () { show(r.id); });
        td.appendChild(b);
      }
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
    fitTableHeight();
    wrap.scrollTop = firstRender || wasAtBottom ? wrap.scrollHeight : scrollTop;
    firstRender = false;
  }

  function getJson(url) {
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
      return r.json();
    });
  }

  function refresh() {
    var url = '/proxy/api/rows?limit=' + encodeURIComponent($('limit').value) +
      '&tunnels=' + ($('tunnels').checked ? '1' : '0') +
      '&telemetry=' + ($('telemetry').checked ? '1' : '0');
    return getJson(url).then(function (d) {
      renderRows(d.rows);
      $('status').textContent = 'updated ' + new Date().toLocaleTimeString() + ' (' + d.rows.length + ' rows)';
      $('learned').textContent = d.learned && d.learned.length ? 'auto-tunnelled, client rejected the proxy CA: ' + d.learned.join(', ') : '';
    }).catch(function (e) { $('status').textContent = 'error: ' + e.message; });
  }

  function show(id) {
    activeId = id;
    Array.prototype.forEach.call(document.querySelectorAll('tr.active'), function (t) { t.classList.remove('active'); });
    var tr = $('row-' + id);
    if (tr) tr.classList.add('active');
    getJson('/proxy/api/rows/' + id).then(function (d) {
      renderSide($('req'), d.request, d.summary);
      renderSide($('res'), d.response, null);
    }).catch(function (e) { $('req').textContent = 'error: ' + e.message; });
  }

  COLS.forEach(function (c) { $('head').appendChild(el('th', null, c)); });
  $('refresh').addEventListener('click', refresh);
  $('limit').addEventListener('change', refresh);
  $('tunnels').addEventListener('change', refresh);
  $('telemetry').addEventListener('change', refresh);
  window.addEventListener('resize', fitTableHeight);
  setInterval(function () { if ($('auto').checked && !document.hidden) refresh(); }, 3000);
  refresh();
})();
`;

module.exports = { html, css, js };
