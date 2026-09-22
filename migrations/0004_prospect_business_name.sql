-- The public lead form ("Get Started") has always collected a business name,
-- but the prospect record never carried the field and the table had no column
-- for it, so every lead's business name was silently discarded on submit.
-- Add the column; existing rows keep NULL because that data is unrecoverable.
ALTER TABLE prospects ADD COLUMN business_name TEXT;
