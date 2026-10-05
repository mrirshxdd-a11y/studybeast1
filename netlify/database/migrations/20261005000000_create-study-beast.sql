CREATE TABLE admin_account (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE auth_attempts (
  id SERIAL PRIMARY KEY,
  scope TEXT NOT NULL,
  ip TEXT NOT NULL,
  success BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX auth_attempts_lookup ON auth_attempts (scope, ip, created_at);

CREATE TABLE member_keys (
  id SERIAL PRIMARY KEY,
  access_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  destination_url TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  device_hash TEXT,
  device_bound_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  login_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE platforms (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  visible BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (
  section TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO admin_account (id, phone, password_hash) VALUES (1, '9387547483', 'scrypt$16384$8$1$lOMkwmUeVMxlAiuymT2yhQ==$8VZ1C1DIHnVClyBvYcl+FxMRRsidcaRRG384ovB48tCfJdNl4Ft05SQ1cxqyqKeIoeIZTO7Ohs+Vfm/ed3y+PQ==');

INSERT INTO member_keys (access_key, label, destination_url) VALUES
  ('PWSB-VIPK-MRIR', 'PW Batches', 'https://pw-nextstudy.ai.studio/batches'),
  ('NTSB-MRIR-VIPK', 'Next Toppers', 'https://nt.studybeepro.site/'),
  ('VIPK-SBRT-MRIR', 'AS Multiverse', 'https://asmultiverse.in/');

INSERT INTO platforms (name, sort_order) VALUES
  ('PW Mod', 1), ('Next Toppers Mod', 2), ('Mission JEET Mod', 3), ('Unacademy Mod', 4),
  ('KGS Mod', 5), ('Rojgar With Ankit Mod', 6), ('Vibrant Academy Mod', 7), ('Career Will Mod', 8),
  ('Selection Way Mod', 9), ('Vidyakul Mod', 10), ('Vidyagram Mod', 11), ('Master Sahab Mod', 12),
  ('Yes Officer Mod', 13), ('Futurekul Mod', 14), ('Sachin Academy Mod', 15), ('Barrier Will Mod', 16),
  ('Education Baba Mod', 17), ('Apna College Mod', 18), ('Target Board Mod', 19), ('KD Live Mod', 20),
  ('Study IQ Mod', 21), ('Science & Fun Mod', 22), ('Utkarsh Classes Mod', 23), ('+ More', 24);
