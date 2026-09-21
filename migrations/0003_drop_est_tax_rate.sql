-- Reverts the short-lived est_tax_rate column. The estimated-payment feature was
-- removed: quarterly estimates depend on far more than book P&L (entity type, SE
-- tax, QBI, household withholding, safe harbor, state layer), and Intuit Tax
-- Advisor is the right tool for computing them. No API exists to pull that plan,
-- and hand-maintaining a schedule per client per quarter was not worth the
-- staleness risk of showing a client an outdated number.
ALTER TABLE clients DROP COLUMN est_tax_rate;
