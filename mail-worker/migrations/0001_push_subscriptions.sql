CREATE TABLE IF NOT EXISTS push_subscription (
    push_subscription_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    session_token TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    expiration_time INTEGER,
    user_agent TEXT NOT NULL DEFAULT '',
    create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscription_endpoint
    ON push_subscription(endpoint);

CREATE INDEX IF NOT EXISTS idx_push_subscription_user_id
    ON push_subscription(user_id, update_time DESC);
