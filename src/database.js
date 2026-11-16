const schema = [
  `CREATE TABLE IF NOT EXISTS mailbox_usage (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    bytes INTEGER NOT NULL DEFAULT 0,
    messages INTEGER NOT NULL DEFAULT 0
  )`,
  "INSERT OR IGNORE INTO mailbox_usage (id) VALUES (1)",
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    from_address TEXT NOT NULL,
    from_name TEXT NOT NULL,
    subject TEXT NOT NULL,
    code TEXT NOT NULL,
    text TEXT NOT NULL,
    html TEXT NOT NULL,
    preview TEXT NOT NULL,
    status TEXT NOT NULL,
    omitted_images INTEGER NOT NULL DEFAULT 0,
    received_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    storage_bytes INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS messages_recent ON messages (received_at DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS messages_address_recent ON messages (address, received_at DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS messages_expiry ON messages (expires_at)",
  `CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    content_id TEXT NOT NULL,
    content_type TEXT NOT NULL,
    data BLOB NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS images_message ON images (message_id)",
  // 容量检查与计数随邮件写入同一事务，不扫描全部邮件。
  `CREATE TRIGGER IF NOT EXISTS messages_capacity BEFORE INSERT ON messages
  BEGIN
    SELECT CASE WHEN (SELECT messages >= 5000 OR bytes + NEW.storage_bytes > 104857600 FROM mailbox_usage WHERE id = 1)
      THEN RAISE(ABORT, 'MAILBOX_FULL') END;
  END`,
  `CREATE TRIGGER IF NOT EXISTS messages_added AFTER INSERT ON messages
  BEGIN
    UPDATE mailbox_usage SET bytes = bytes + NEW.storage_bytes, messages = messages + 1 WHERE id = 1;
  END`,
  `CREATE TRIGGER IF NOT EXISTS messages_removed AFTER DELETE ON messages
  BEGIN
    UPDATE mailbox_usage SET bytes = bytes - OLD.storage_bytes, messages = messages - 1 WHERE id = 1;
  END`,
];

const initialized = new WeakMap();

export function ensureDatabase(db) {
  if (!db) throw new Error("DATABASE_NOT_BOUND");
  let ready = initialized.get(db);
  if (!ready) {
    ready = db.batch(schema.map((sql) => db.prepare(sql))).catch((error) => {
      initialized.delete(db);
      throw error;
    });
    initialized.set(db, ready);
  }
  return ready;
}
