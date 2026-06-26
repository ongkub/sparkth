CREATE TABLE IF NOT EXISTS rsvp_submissions (
  line_user_id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  nickname TEXT NOT NULL DEFAULT '',
  full_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  side TEXT NOT NULL DEFAULT '',
  relationship TEXT NOT NULL DEFAULT '',
  guests INTEGER NOT NULL DEFAULT 1,
  dietary TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  session TEXT NOT NULL DEFAULT '',
  picture_url TEXT NOT NULL DEFAULT '',
  table_name TEXT NOT NULL DEFAULT '',
  checked_in_at TIMESTAMPTZ,
  checkin_source TEXT NOT NULL DEFAULT '',
  is_single BOOLEAN NOT NULL DEFAULT false,
  instagram TEXT NOT NULL DEFAULT '',
  show_social_on_wall BOOLEAN NOT NULL DEFAULT false,
  wall_frame TEXT NOT NULL DEFAULT 'classic',
  welcome_announced_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS visitors (
  line_user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'visited',
  picture_url TEXT NOT NULL DEFAULT '',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invites (
  id BIGSERIAL PRIMARY KEY,
  sender_uid TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  sender_picture TEXT NOT NULL DEFAULT '',
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS checkins (
  id BIGSERIAL PRIMARY KEY,
  line_user_id TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  nickname TEXT NOT NULL DEFAULT '',
  picture_url TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  beacon_type TEXT NOT NULL DEFAULT '',
  table_name TEXT NOT NULL DEFAULT '',
  is_single BOOLEAN NOT NULL DEFAULT false,
  instagram TEXT NOT NULL DEFAULT '',
  show_social_on_wall BOOLEAN NOT NULL DEFAULT false,
  wall_frame TEXT NOT NULL DEFAULT 'classic',
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS line_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL DEFAULT '',
  line_user_id TEXT NOT NULL DEFAULT '',
  beacon_type TEXT NOT NULL DEFAULT '',
  destination TEXT NOT NULL DEFAULT '',
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS seating_maps (
  map_key TEXT PRIMARY KEY,
  map_mime TEXT NOT NULL DEFAULT 'image/jpeg',
  map_data TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS frame_templates (
  frame_key TEXT PRIMARY KEY,
  frame_label TEXT NOT NULL DEFAULT '',
  frame_mime TEXT NOT NULL DEFAULT 'image/png',
  frame_data TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rsvp_submitted_at ON rsvp_submissions (submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_invites_sent_at ON invites (sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkins_checked_in_at ON checkins (checked_in_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkins_line_user_id ON checkins (line_user_id);
CREATE INDEX IF NOT EXISTS idx_line_webhook_events_received_at ON line_webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_line_webhook_events_line_user_id ON line_webhook_events (line_user_id);
