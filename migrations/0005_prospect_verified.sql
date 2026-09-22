-- Whether the lead passed the Turnstile human check. A failed check no longer
-- rejects the submission (losing a real prospect costs more than storing a spam
-- row), so the outcome is recorded here instead and surfaced in the admin list
-- and the notification email. Pre-existing rows predate the check entirely.
ALTER TABLE prospects ADD COLUMN verified INTEGER DEFAULT 0;
