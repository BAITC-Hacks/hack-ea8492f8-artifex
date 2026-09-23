import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AnalysisResult, AnalysisRun, Review } from '../shared/schema.js';
import type { ExtractedPair } from '../shared/extraction.js';

export class Store {
  private db: DatabaseSync;
  constructor(path = resolve('.data/lineage.sqlite')) {
    if (path !== ':memory:') mkdirSync(resolve(path, '..'), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, title TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews (run_id TEXT NOT NULL, finding_id TEXT NOT NULL, review TEXT NOT NULL, PRIMARY KEY(run_id, finding_id));
      CREATE TABLE IF NOT EXISTS normalization_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS extractions (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  save(result: AnalysisResult) {
    this.db
      .prepare('INSERT INTO runs (id, created_at, title, result) VALUES (?, ?, ?, ?)')
      .run(result.id, result.createdAt, result.title, JSON.stringify(result));
  }
  list() {
    return this.db
      .prepare('SELECT id, created_at AS createdAt, title FROM runs ORDER BY created_at DESC LIMIT 50')
      .all();
  }
  get(id: string): AnalysisRun | null {
    const row = this.db.prepare('SELECT result FROM runs WHERE id = ?').get(id) as
      { result: string } | undefined;
    if (!row) return null;
    const reviews: Record<string, Review> = Object.create(null);
    for (const r of this.db.prepare('SELECT finding_id, review FROM reviews WHERE run_id = ?').all(id) as {
      finding_id: string;
      review: string;
    }[])
      reviews[r.finding_id] = JSON.parse(r.review);
    return { result: JSON.parse(row.result), reviews };
  }
  review(runId: string, findingId: string, review: Review) {
    const record = { ...review, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        'INSERT INTO reviews VALUES (?, ?, ?) ON CONFLICT(run_id, finding_id) DO UPDATE SET review=excluded.review',
      )
      .run(runId, findingId, JSON.stringify(record));
    return record;
  }
  cacheGet(key: string): unknown | null {
    const row = this.db.prepare('SELECT value FROM normalization_cache WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  cacheSet(key: string, value: unknown) {
    this.db
      .prepare('INSERT OR REPLACE INTO normalization_cache VALUES (?, ?)')
      .run(key, JSON.stringify(value));
  }
  close() {
    this.db.close();
  }
  saveExtraction(id: string, value: ExtractedPair) {
    this.db.prepare('INSERT INTO extractions VALUES (?, ?)').run(id, JSON.stringify(value));
  }
  getExtraction(id: string): ExtractedPair | null {
    const row = this.db.prepare('SELECT value FROM extractions WHERE id = ?').get(id) as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
}
