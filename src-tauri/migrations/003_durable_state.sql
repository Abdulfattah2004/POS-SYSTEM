-- Additive upgrade. Original tables, IDs and historical values are retained.
-- Root document commits business events, inventory, request fingerprints and
-- offline operations together. Revision CAS serializes competing windows.
CREATE TABLE IF NOT EXISTS pos_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    document TEXT NOT NULL CHECK (json_valid(document))
);
CREATE TABLE IF NOT EXISTS pos_upgrade_events (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    description TEXT NOT NULL
);
INSERT INTO pos_upgrade_events(version, description) VALUES
    (3, 'Add durable state and outbox; retain original relational history')
ON CONFLICT(version) DO NOTHING;
