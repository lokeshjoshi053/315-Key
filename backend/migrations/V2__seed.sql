insert into app_config (key, value) values
    ('hold_minutes', '15'),
    ('cooling_days', '7'),
    ('bookings_enabled', 'true'),
    ('min_app_version', '1.0.0'),
    ('min_payout_paise', '10000'),
    ('admin_bps', '2000'),
    ('tds_bps', '500'),
    ('matching_power_pct', '70'),
    ('matching_weak_pct', '30'),
    ('matching_bonus_bps', '5000'),
    ('support_phone', ''),
    ('support_email', '');

-- PDF §6. Amounts in paise.
insert into tier (code, name, amount_paise, l1_bps, l2_bps, l3_bps, sort) values
    ('EXPRESS',  'Express Token',  2100000,  1000, 500,  500,  1),
    ('ADVANCE',  'Advance Token',  7100000,  1500, 500,  500,  2),
    ('SILVER',   'Silver',         15100000, 1500, 1000, 1000, 3),
    ('GOLD',     'Gold',           30000000, 2000, 1000, 1000, 4),
    ('PLATINUM', 'Platinum',       65100000, 2500, 1500, 1000, 5);

-- 315 plots at ₹50 L. Admin edits block/facing/coordinates via CSV import.
insert into plot (plot_no, price_paise)
select 'P-' || lpad(n::text, 3, '0'), 500000000 from generate_series(1, 315) n;
