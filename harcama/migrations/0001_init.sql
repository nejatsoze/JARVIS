-- Harcama kayıtları. Tutarlar kuruş cinsinden tamsayı (kayan nokta hatası olmasın diye).
CREATE TABLE transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant     TEXT    NOT NULL CHECK (length(merchant) BETWEEN 1 AND 120),
  -- NULL: banka tutar göndermedi, kullanıcının girmesi bekleniyor.
  amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency     TEXT    NOT NULL DEFAULT 'TRY' CHECK (length(currency) = 3),
  card         TEXT    CHECK (card IS NULL OR length(card) <= 80),
  category     TEXT    NOT NULL,
  note         TEXT    CHECK (note IS NULL OR length(note) <= 280),
  source       TEXT    NOT NULL CHECK (source IN ('shortcut', 'manual')),
  occurred_at  TEXT    NOT NULL, -- ISO 8601, UTC
  local_date   TEXT    NOT NULL CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Ay/gün sorguları ve mükerrer kontrolü için.
CREATE INDEX idx_transactions_local_date ON transactions (local_date);
CREATE INDEX idx_transactions_dedupe ON transactions (merchant, occurred_at);

-- Kullanıcı bir işyerinin kategorisini değiştirince öğrenilir, sonraki ödemelerde uygulanır.
CREATE TABLE merchant_categories (
  merchant_key TEXT PRIMARY KEY,
  category     TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
