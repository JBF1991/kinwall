-- OIDC login is separate from calendar consent and Kinwall's connected-app OAuth server.
-- No provider access/refresh/ID tokens are retained. Only short-lived login ceremony data.
CREATE TABLE oidc_flows (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  data TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX oidc_flows_expiry ON oidc_flows(expires_at);
CREATE TABLE oidc_handoffs (
  browser_hash TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX oidc_handoffs_expiry ON oidc_handoffs(expires_at);
ALTER TABLE api_keys ADD COLUMN oidc_issuer TEXT;
ALTER TABLE api_keys ADD COLUMN oidc_client_id TEXT;
ALTER TABLE api_keys ADD COLUMN oidc_subject TEXT;
