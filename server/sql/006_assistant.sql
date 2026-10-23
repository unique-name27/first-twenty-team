-- 006_assistant (docs/SERVER.md, "Lark, the assistant"; server/src/assistant).
-- Never edit a migration that has been applied anywhere: add server/sql/007_*.sql instead.
--
-- How much each company asked the in-app assistant, per day (UTC): the messages its logins sent (the daily
-- limits ASSISTANT_DAILY_PER_WORKSPACE and ASSISTANT_DAILY_GLOBAL count these) and the tokens Claude read
-- and wrote for them, as the API bills them: input read at full price (input_tokens), input written to the
-- prompt cache (cache_creation_input_tokens) and read from it (cache_read_input_tokens), and output with the
-- thinking in it (output_tokens). One row per company and day, nothing of what was asked or answered.
-- Deleting a company deletes its rows (the foreign key cascades; deleteDemoWorkspace also deletes them by
-- name). Holds no credentials, so server/deploy/viewer-role.sql lets the read-only login see it.

CREATE TABLE assistant_usage (
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  day date NOT NULL,
  messages int NOT NULL DEFAULT 0 CHECK (messages >= 0),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  cache_creation_input_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_creation_input_tokens >= 0),
  cache_read_input_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_read_input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  PRIMARY KEY (workspace_id, day)
);

-- The server-wide daily count reads one day across every company.
CREATE INDEX assistant_usage_day_idx ON assistant_usage (day);
