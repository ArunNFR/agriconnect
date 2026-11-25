'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

let db = null;

function open(file) {
  if (db) db.close();
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}

function get() {
  if (!db) throw new Error('database not opened');
  return db;
}

const one = (sql, ...p) => get().prepare(sql).get(...p);
const all = (sql, ...p) => get().prepare(sql).all(...p);
const run = (sql, ...p) => get().prepare(sql).run(...p);

let depth = 0;
/** Run fn inside a transaction (nested calls use savepoints). */
function tx(fn) {
  const d = get();
  const sp = `sp_${depth}`;
  if (depth === 0) d.exec('BEGIN IMMEDIATE'); else d.exec(`SAVEPOINT ${sp}`);
  depth++;
  try {
    const r = fn();
    depth--;
    if (depth === 0) d.exec('COMMIT'); else d.exec(`RELEASE ${sp}`);
    return r;
  } catch (e) {
    depth--;
    if (depth === 0) d.exec('ROLLBACK'); else d.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}

/** Insert a row object, return new id. */
function insert(table, row) {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return Number(run(sql, ...keys.map((k) => norm(row[k]))).lastInsertRowid);
}

function update(table, id, patch, idCol = 'id') {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`, ...keys.map((k) => norm(patch[k])), id);
}

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

module.exports = { open, get, one, all, run, tx, insert, update };
