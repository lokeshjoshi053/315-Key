-- Fields the mobile app (API v1) displays.
alter table plot add column road_width text;
alter table plot add column image_url text;
alter table plot add column location text;

insert into app_config (key, value) values
    ('project_location', '315 PLOTS'),
    ('default_road_width', '30 ft'),
    ('default_plot_image_url', 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c'),
    ('popular_tier_code', 'GOLD'),
    ('payout_schedule', 'After admin approval')
on conflict (key) do nothing;

-- Partner onboarding details submitted from the app, kept until an admin approves.
create table partner_application (
    user_id       uuid primary key references app_user (id),
    holder_name   text not null,
    pan_enc       bytea not null,
    pan_last4     text not null,
    account_enc   bytea not null,
    account_last4 text not null,
    ifsc          text not null,
    submitted_at  timestamptz not null default now()
);
