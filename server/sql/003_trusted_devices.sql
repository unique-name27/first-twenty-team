-- 003_trusted_devices (docs/SYNC.md, Security rules).
-- Never edit a migration that has been applied anywhere: add server/sql/004_*.sql instead.
--
-- Browsers a user has signed in from. A successful sign-in gives the browser a long-lived trusted-device
-- cookie; a later sign-in that carries it for the same login skips the per-email and per-address limits
-- and counts against a limit of its own, so password guessing for that email from many addresses cannot
-- lock its owner out of a browser they already use. Like sessions, only the SHA-256 of the token is stored.

CREATE TABLE trusted_devices (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX trusted_devices_user_idx ON trusted_devices (user_id, created_at);
