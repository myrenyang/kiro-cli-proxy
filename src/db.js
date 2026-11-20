'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { classifyRequest } = require('./classify');

// All SQLite access lives in this module so the storage engine can be swapped
// in one place.

const COLUMNS = [
  ['kind', 'TEXT NOT NULL'],            // 'mitm' (decrypted) or 'tunnel' (blind)
  ['category', 'TEXT'],                 // what the request was for, see classify.js (chat, telemetry, ...)
  ['ts', 'INTEGER NOT NULL'],           // unix epoch ms at request start
  ['host', 'TEXT NOT NULL'],
  ['port', 'INTEGER'],
  ['method', 'TEXT'],
  ['path', 'TEXT'],
  ['operation', 'TEXT'],                // from x-amz-target
  ['status', 'INTEGER'],
  ['ttfb_ms', 'INTEGER'],               // time to response headers
  ['duration_ms', 'INTEGER'],
  ['req_bytes', 'INTEGER'],             // wire size of the request body (tunnel: client to server)
  ['res_bytes', 'INTEGER'],             // wire size of the response body (tunnel: server to client)
  ['req_truncated', 'INTEGER'],
  ['res_truncated', 'INTEGER'],
  ['aborted', 'INTEGER'],
  ['error', 'TEXT'],
  ['req_headers', 'TEXT'],              // JSON, secrets redacted
  ['res_headers', 'TEXT'],              // JSON, secrets redacted
  ['req_body', 'BLOB'],                 // raw bytes as sent, capped
  ['res_body', 'BLOB'],                 // raw bytes as received, capped
  ['conversation_id', 'TEXT'],
  ['model_id', 'TEXT'],
  ['history_count', 'INTEGER'],
  ['tools_count', 'INTEGER'],
  ['cwd', 'TEXT'],
  ['last_user_message', 'TEXT'],
  ['res_text', 'TEXT'],                 // assembled assistant reply
  ['res_events', 'TEXT'],               // JSON counts per event type
  ['context_usage', 'TEXT'],            // raw JSON of the contextUsageEvent payload
  ['metering', 'TEXT'],                 // raw JSON of the meteringEvent payload(s)
];

const COLUMN_NAMES = COLUMNS.map(([n]) => n);
const LIST_COLUMNS = COLUMN_NAMES.filter(n => n !== 'req_body' && n !== 'res_body' && n !== 'req_headers' && n !== 'res_headers' && n !== 'res_text' && n !== 'last_user_message');

// Brings a database created by an older version up to date. Safe to run on every start:
// it only adds what is missing and only touches rows whose category is still NULL (rows
// written before the column existed, or by an older proxy that was still running).
// A build of this proxy briefly called the column "type"; such databases are renamed in place.
// Returns the number of rows that were classified.
function migrate(db) {
  const columns = db.prepare('PRAGMA table_info(transactions)').all().map(c => c.name);
  db.exec('DROP INDEX IF EXISTS idx_transactions_type_id');
  if (columns.includes('type') && !columns.includes('category')) {
    db.exec('ALTER TABLE transactions RENAME COLUMN type TO category');
  } else if (!columns.includes('category')) {
    db.exec('ALTER TABLE transactions ADD COLUMN category TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_category_id ON transactions(category, id)');

  const todo = db.prepare('SELECT id, kind, host, operation FROM transactions WHERE category IS NULL').all();
  if (todo.length === 0) return 0;
  const update = db.prepare('UPDATE transactions SET category = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of todo) update.run(classifyRequest(r), r.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return todo.length;
}

// Builds the row-list query. Visible rows are the union of up to three branches, each of
// which is a single ordered index range scan with its own LIMIT (so the cost is bounded by
// the limit, not by the table size):
//   decrypted rows that are not telemetry   -> idx_transactions_kind_id
//   blind tunnels that are not telemetry    -> idx_transactions_kind_id   (only if `tunnels`)
//   telemetry rows of any kind              -> idx_transactions_category_id   (only if `telemetry`)
// `IS NOT` rather than `<>` so rows whose category is still NULL are not silently dropped.
// Aborted rows (aborted = 1) are hidden unless `aborted` is set, independently of the above.
function buildListSql({ tunnels = false, telemetry = false, aborted = false } = {}) {
  const cols = `id, ${LIST_COLUMNS.join(',')}`;
  const wheres = ["kind = 'mitm' AND category IS NOT 'telemetry'"];
  if (tunnels) wheres.push("kind = 'tunnel' AND category IS NOT 'telemetry'");
  if (telemetry) wheres.push("category = 'telemetry'");
  const abortedClause = aborted ? '' : ' AND aborted IS NOT 1';
  const branch = w => `SELECT ${cols} FROM transactions WHERE (${w})${abortedClause} ORDER BY id DESC LIMIT @limit`;
  if (wheres.length === 1) return branch(wheres[0]);
  return `SELECT * FROM (${wheres.map(w => `SELECT * FROM (${branch(w)})`).join(' UNION ALL ')}) ORDER BY id DESC LIMIT @limit`;
}

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ${COLUMNS.map(([n, t]) => `${n} ${t}`).join(',\n    ')}
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_kind_id ON transactions(kind, id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_ts ON transactions(ts)');
  const backfilled = migrate(db);

  const insertSql = `INSERT INTO transactions (${COLUMN_NAMES.join(',')}) VALUES (${COLUMN_NAMES.map(n => '@' + n).join(',')})`;
  const insertStmt = db.prepare(insertSql);

  function insert(row) {
    const params = {};
    for (const n of COLUMN_NAMES) {
      const v = row[n];
      params[n] = v === undefined ? null : (typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (params.category === null) params.category = classifyRequest(row);
    const info = insertStmt.run(params);
    return Number(info.lastInsertRowid);
  }

  // See buildListSql for which rows are visible. `limit` applies to the visible rows.
  function list({ limit = 8, tunnels = false, telemetry = false, aborted = false } = {}) {
    const n = Math.min(Math.max(Number.parseInt(limit, 10) || 8, 1), 500);
    return db.prepare(buildListSql({ tunnels, telemetry, aborted })).all({ limit: n }).map(plain);
  }

  function get(id) {
    const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    return row ? plain(row) : null;
  }

  // Delete a row only when it is BOTH older than `days` AND outside the newest
  // `count` rows of its kind. Tunnel rows carry no bodies and are not part of
  // the "newest N" budget, so they are deleted by age alone.
  function purge({ days, count, now = Date.now() }) {
    const cutoff = now - days * 86400000;
    const mitm = db.prepare(
      `DELETE FROM transactions WHERE kind = 'mitm' AND ts < ?
         AND id NOT IN (SELECT id FROM transactions WHERE kind = 'mitm' ORDER BY id DESC LIMIT ?)`
    ).run(cutoff, count);
    const tunnel = db.prepare("DELETE FROM transactions WHERE kind = 'tunnel' AND ts < ?").run(cutoff);
    return Number(mitm.changes) + Number(tunnel.changes);
  }

  function count() {
    return Number(db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c);
  }

  return { insert, list, get, purge, count, backfilled, close: () => db.close(), raw: db };
}

// node:sqlite returns null-prototype objects; copy to ordinary ones.
function plain(row) {
  return Object.assign({}, row);
}

module.exports = { openDb, buildListSql, COLUMN_NAMES };
