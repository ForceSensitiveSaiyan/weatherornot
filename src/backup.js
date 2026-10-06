// Daily copies of the database. VACUUM INTO writes a clean, consistent copy
// while the game keeps running, and we keep the newest few.
import { mkdirSync, readdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const NAME = /^weatherornot-(\d{4}-\d{2}-\d{2})\.db$/;

// Makes today's copy if there isn't one yet, then deletes all but the newest
// `keep`. Returns the new file's path, or null if today's was already done.
export function backupDaily(db, dir, date, keep = 14) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `weatherornot-${date}.db`);
  let made = null;
  if (!existsSync(file)) {
    // Write to a temporary name and rename once complete, so a crash
    // part-way through never leaves a half-written backup.
    const tmp = `${file}.part`;
    rmSync(tmp, { force: true });
    db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
    renameSync(tmp, file);
    made = file;
  }
  const old = readdirSync(dir).filter((f) => NAME.test(f)).sort().reverse().slice(keep);
  for (const f of old) rmSync(join(dir, f));
  return made;
}
