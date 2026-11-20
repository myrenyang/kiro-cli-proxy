'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, buildListSql } = require('../src/db');

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);

function mitm(db, ageDays, extra = {}) {
  return db.insert({ kind: 'mitm', ts: NOW - ageDays * DAY, host: 'h', ...extra });
}
function tunnel(db, ageDays) {
  return db.insert({ kind: 'tunnel', ts: NOW - ageDays * DAY, host: 't' });
}

test('insert/get round-trips blobs, booleans and nulls', () => {
  const db = openDb(':memory:');
  const id = db.insert({ kind: 'mitm', ts: 1, host: 'h', req_body: Buffer.from([1, 2, 3]), aborted: true, req_truncated: false });
  const row = db.get(id);
  assert.deepEqual(Buffer.from(row.req_body), Buffer.from([1, 2, 3]));
  assert.equal(row.aborted, 1);
  assert.equal(row.req_truncated, 0);
  assert.equal(row.status, null);
  assert.equal(db.get(999), null);
  db.close();
});

test('list excludes tunnels by default, orders newest first, omits bodies, clamps limit', () => {
  const db = openDb(':memory:');
  for (let i = 0; i < 5; i++) mitm(db, 0, { req_body: Buffer.from('x') });
  tunnel(db, 0);
  const rows = db.list({ limit: 3 });
  assert.equal(rows.length, 3);
  assert.ok(rows[0].id > rows[1].id);
  assert.ok(rows.every(r => r.kind === 'mitm'));
  assert.ok(!('req_body' in rows[0]) && !('res_body' in rows[0]));
  assert.equal(db.list({ limit: 100, tunnels: true }).length, 6);
  assert.equal(db.list({ limit: 'garbage' }).length, 5);
  db.close();
});

test('insert classifies the row and keeps an explicit category', () => {
  const db = openDb(':memory:');
  const a = db.insert({ kind: 'mitm', ts: 1, host: 'runtime.eu-central-1.kiro.dev', operation: 'GenerateAssistantResponse' });
  const b = db.insert({ kind: 'tunnel', ts: 1, host: 'telemetry.eu-central-1.kiro.dev' });
  const c = db.insert({ kind: 'tunnel', ts: 1, host: 'example.com', category: 'custom' });
  assert.equal(db.get(a).category, 'chat');
  assert.equal(db.get(b).category, 'telemetry');
  assert.equal(db.get(c).category, 'custom');
  assert.equal(db.list({ limit: 5, tunnels: true, telemetry: true }).find(r => r.id === a).category, 'chat');
  db.close();
});

test('opening a database from before the category column adds it, classifies old rows, and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcp-mig-'));
  const file = path.join(dir, 'old.db');
  try {
    // Build the schema from before this feature faithfully: a current database with the
    // `category` column and its index removed again.
    const seed = openDb(file);
    const add = (kind, ts, host, operation, req_body) => seed.insert({ kind, ts, host, operation, req_body, category: 'placeholder' });
    add('mitm', 1, 'runtime.eu-central-1.kiro.dev', 'GenerateAssistantResponse', Buffer.from('keep me'));
    add('tunnel', 2, 'client-telemetry.us-east-1.amazonaws.com');
    add('tunnel', 3, 'management.eu-central-1.kiro.dev');
    add('tunnel', 4, 'something.example.org');
    seed.raw.exec('DROP INDEX idx_transactions_category_id');
    seed.raw.exec('ALTER TABLE transactions DROP COLUMN category');
    assert.ok(!seed.raw.prepare('PRAGMA table_info(transactions)').all().some(c => c.name === 'category'));
    seed.close();

    const db = openDb(file);
    assert.equal(db.backfilled, 4);
    const categories = db.raw.prepare('SELECT category FROM transactions ORDER BY id').all().map(r => r.category);
    assert.deepEqual(categories, ['chat', 'telemetry', 'management', 'other']);
    assert.equal(Buffer.from(db.get(1).req_body).toString(), 'keep me', 'existing data is untouched');
    const indexes = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(r => r.name);
    assert.ok(indexes.includes('idx_transactions_category_id'));
    // New writes after the migration are classified too.
    const id = db.insert({ kind: 'tunnel', ts: 5, host: 'telemetry.eu-central-1.kiro.dev' });
    assert.equal(db.get(id).category, 'telemetry');
    db.close();

    const again = openDb(file);
    assert.equal(again.backfilled, 0, 'second open has nothing to do');
    again.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a database whose column was still called "type" is renamed in place, keeping its values and bodies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcp-mig-'));
  const file = path.join(dir, 'type.db');
  try {
    const seed = openDb(file);
    const id = seed.insert({ kind: 'mitm', ts: 1, host: 'runtime.eu-central-1.kiro.dev', operation: 'GenerateAssistantResponse', req_body: Buffer.from('keep me') });
    seed.insert({ kind: 'tunnel', ts: 2, host: 'example.com', category: 'custom-value' });
    // Recreate the intermediate schema: column and index named "type".
    seed.raw.exec('DROP INDEX idx_transactions_category_id');
    seed.raw.exec('ALTER TABLE transactions RENAME COLUMN category TO type');
    seed.raw.exec('CREATE INDEX idx_transactions_type_id ON transactions(type, id)');
    seed.close();

    const db = openDb(file);
    const cols = db.raw.prepare('PRAGMA table_info(transactions)').all().map(c => c.name);
    assert.ok(cols.includes('category') && !cols.includes('type'));
    const indexes = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(r => r.name);
    assert.ok(indexes.includes('idx_transactions_category_id') && !indexes.includes('idx_transactions_type_id'));
    assert.equal(db.backfilled, 0, 'values were carried over, nothing to reclassify');
    assert.equal(db.get(id).category, 'chat');
    assert.equal(db.raw.prepare("SELECT category FROM transactions WHERE host = 'example.com'").get().category, 'custom-value');
    assert.equal(Buffer.from(db.get(id).req_body).toString(), 'keep me');
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a row written without a category (by an older proxy still running) is classified on the next open and is not hidden meanwhile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcp-mig-'));
  const file = path.join(dir, 'x.db');
  try {
    const db = openDb(file);
    db.raw.exec("INSERT INTO transactions (kind, ts, host) VALUES ('mitm', 1, 'runtime.eu-central-1.kiro.dev')"); // category stays NULL
    assert.equal(db.list({ limit: 10 }).length, 1, 'IS NOT keeps NULL-category rows visible');
    db.close();
    const next = openDb(file);
    assert.equal(next.backfilled, 1);
    next.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every filter combination is answered from an index, never a full table scan', () => {
  const db = openDb(':memory:');
  for (const o of [{}, { tunnels: true }, { telemetry: true }, { tunnels: true, telemetry: true },
    { aborted: true }, { tunnels: true, aborted: true }, { tunnels: true, telemetry: true, aborted: true }]) {
    const plan = db.raw.prepare(`EXPLAIN QUERY PLAN ${buildListSql(o)}`).all({ limit: 8 }).map(r => r.detail).join('\n');
    assert.ok(!/SCAN transactions/.test(plan), `full scan for ${JSON.stringify(o)}:\n${plan}`);
    assert.match(plan, /SEARCH transactions USING INDEX idx_transactions_kind_id/);
    assert.equal(/idx_transactions_category_id/.test(plan), !!o.telemetry, `category index is used exactly when telemetry is shown (${JSON.stringify(o)})`);
  }
  db.close();
});

test('aborted rows are hidden unless asked for, across every category, and the limit applies after filtering', () => {
  const db = openDb(':memory:');
  const add = (kind, host, aborted) => db.insert({ kind, ts: NOW, host, aborted });
  const chatOk = add('mitm', 'runtime.eu-central-1.kiro.dev', false);
  const chatAborted = add('mitm', 'runtime.eu-central-1.kiro.dev', true);
  const tunnelOk = add('tunnel', 'example.com', false);
  const tunnelAborted = add('tunnel', 'example.com', true);
  const ids = opts => db.list({ limit: 100, ...opts }).map(r => r.id);

  // Default: no aborted rows at all, even with tunnels shown.
  assert.deepEqual(ids({ tunnels: true }).sort(), [chatOk, tunnelOk].sort());
  assert.ok(!ids({ tunnels: true }).includes(chatAborted));
  // show aborted: brings them back within the active category/kind filters.
  assert.deepEqual(ids({ tunnels: true, aborted: true }).sort(), [chatOk, chatAborted, tunnelOk, tunnelAborted].sort());
  // aborted alone (tunnels off) still respects the tunnels filter.
  assert.deepEqual(ids({ aborted: true }).sort(), [chatOk, chatAborted].sort());

  // Newer aborted rows must not push a visible row out of a 1-row window when aborted is off.
  for (let i = 0; i < 5; i++) add('mitm', 'runtime.eu-central-1.kiro.dev', true);
  const win = db.list({ limit: 1 });
  assert.equal(win.length, 1);
  assert.equal(win[0].aborted, 0);
  db.close();
});

test('telemetry rows are hidden unless asked for, independent of the tunnels filter, and limit applies after filtering', () => {
  const db = openDb(':memory:');
  const add = (kind, host) => db.insert({ kind, ts: NOW, host });
  add('mitm', 'runtime.eu-central-1.kiro.dev');
  add('mitm', 'runtime.eu-central-1.kiro.dev');
  add('tunnel', 'management.eu-central-1.kiro.dev');
  add('tunnel', 'telemetry.eu-central-1.kiro.dev');
  add('tunnel', 'client-telemetry.us-east-1.amazonaws.com');
  add('mitm', 'telemetry.decrypted.example');   // decrypted on purpose: still a telemetry host
  const hosts = opts => db.list({ limit: 100, ...opts }).map(r => r.host).sort();

  assert.equal(hosts({}).length, 2, 'default: decrypted non-telemetry rows only');
  assert.equal(hosts({ tunnels: true }).length, 3, 'tunnels adds non-telemetry tunnels, not telemetry');
  assert.ok(!hosts({ tunnels: true }).some(h => h.includes('telemetry')));
  const tel = hosts({ telemetry: true });
  assert.equal(tel.length, 5, 'telemetry alone: chat rows + all 3 telemetry rows, but not the management tunnel');
  assert.ok(!tel.includes('management.eu-central-1.kiro.dev'));
  assert.equal(hosts({ tunnels: true, telemetry: true }).length, 6);

  // 10 newer telemetry rows must not push the chat rows out of a 2-row window.
  for (let i = 0; i < 10; i++) add('tunnel', 'client-telemetry.us-east-1.amazonaws.com');
  const window = db.list({ limit: 2 });
  assert.equal(window.length, 2);
  assert.ok(window.every(r => r.kind === 'mitm' && !r.host.includes('telemetry')));
  db.close();
});

test('purge deletes a mitm row only if older than N days AND outside the newest M', () => {
  const db = openDb(':memory:');
  const oldRows = [mitm(db, 30), mitm(db, 20), mitm(db, 10)]; // all older than 7 days, ids 1-3
  const recentA = mitm(db, 1);                                // id 4, recent
  const recentB = mitm(db, 0);                                // id 5, recent
  // Newest 2 by id are 4 and 5, so ids 1-3 are both old AND outside the newest 2.
  const removed = db.purge({ days: 7, count: 2, now: NOW });
  assert.equal(removed, 3);
  for (const id of oldRows) assert.equal(db.get(id), null);
  assert.ok(db.get(recentA));
  assert.ok(db.get(recentB));
  db.close();
});

test('purge keeps old rows while they are within the newest M', () => {
  const db = openDb(':memory:');
  const a = mitm(db, 30);
  const b = mitm(db, 20);
  assert.equal(db.purge({ days: 7, count: 100, now: NOW }), 0);
  assert.ok(db.get(a) && db.get(b));
  db.close();
});

test('purge keeps recent rows even beyond the newest M', () => {
  const db = openDb(':memory:');
  const ids = [mitm(db, 1), mitm(db, 2), mitm(db, 3)];
  assert.equal(db.purge({ days: 7, count: 1, now: NOW }), 0);
  assert.ok(ids.every(id => db.get(id)));
  db.close();
});

test('tunnel rows are purged by age alone and do not use the newest-M budget', () => {
  const db = openDb(':memory:');
  const oldT = tunnel(db, 30);
  const newT = tunnel(db, 1);
  const m = mitm(db, 0);
  assert.equal(db.purge({ days: 7, count: 1, now: NOW }), 1);
  assert.equal(db.get(oldT), null);
  assert.ok(db.get(newT));
  assert.ok(db.get(m));
  db.close();
});
