create extension if not exists pgcrypto;

create sequence ref_seq;

create table app_config (
    key   text primary key,
    value text not null
);

create table app_user (
    id             uuid primary key default gen_random_uuid(),
    role           text not null default 'USER' check (role in ('USER', 'ADMIN')),
    mobile         text unique,
    email          text unique,
    google_sub     text unique,
    name           text,
    address        text,
    partner_status text not null default 'NONE'
        check (partner_status in ('NONE', 'PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED')),
    sponsor_id     uuid references app_user (id),
    leg            char(1) check (leg in ('L', 'R')),
    referral_code  text unique,
    active         boolean not null default true,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    check (sponsor_id is null or sponsor_id <> id),
    check ((sponsor_id is null) = (leg is null))
);
create index ix_user_sponsor on app_user (sponsor_id);

create table nominee (
    user_id  uuid primary key references app_user (id),
    name     text not null,
    relation text not null,
    mobile   text
);

create table refresh_token (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references app_user (id),
    token_hash text not null unique,
    device_id  text,
    expires_at timestamptz not null,
    revoked_at timestamptz,
    created_at timestamptz not null default now()
);
create index ix_refresh_user on refresh_token (user_id);

create table otp_challenge (
    id          uuid primary key default gen_random_uuid(),
    mobile      text not null,
    code_hash   text not null,
    expires_at  timestamptz not null,
    attempts    int not null default 0,
    consumed_at timestamptz,
    created_at  timestamptz not null default now()
);
create index ix_otp_mobile on otp_challenge (mobile, created_at desc);

create table device_token (
    token      text primary key,
    user_id    uuid not null references app_user (id),
    platform   text not null,
    updated_at timestamptz not null default now()
);
create index ix_device_user on device_token (user_id);

create table lead (
    id                uuid primary key default gen_random_uuid(),
    partner_id        uuid not null references app_user (id),
    name              text not null,
    mobile            text not null,
    note              text,
    converted_user_id uuid references app_user (id),
    created_at        timestamptz not null default now(),
    unique (partner_id, mobile)
);
create index ix_lead_mobile on lead (mobile);

create table plot (
    id          uuid primary key default gen_random_uuid(),
    plot_no     text not null unique,
    block       text,
    facing      text,
    area_sqft   numeric(10, 2),
    price_paise bigint not null check (price_paise > 0),
    lat         double precision,
    lng         double precision,
    status      text not null default 'AVAILABLE' check (status in ('AVAILABLE', 'HELD', 'BOOKED', 'BLOCKED')),
    held_until  timestamptz,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index ix_plot_status on plot (status);

create table tier (
    id           uuid primary key default gen_random_uuid(),
    code         text not null unique,
    name         text not null,
    amount_paise bigint not null check (amount_paise > 0),
    l1_bps       int not null check (l1_bps between 0 and 10000),
    l2_bps       int not null check (l2_bps between 0 and 10000),
    l3_bps       int not null check (l3_bps between 0 and 10000),
    benefits     text,
    active       boolean not null default true,
    sort         int not null default 0
);

create table booking (
    id              uuid primary key default gen_random_uuid(),
    internal_ref    text not null unique,
    user_id         uuid not null references app_user (id),
    plot_id         uuid not null references plot (id),
    tier_id         uuid not null references tier (id),
    amount_paise    bigint not null,
    l1_bps          int not null,
    l2_bps          int not null,
    l3_bps          int not null,
    status          text not null check (status in
        ('PENDING_PAYMENT', 'CONFIRMED', 'EXPIRED', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED')),
    hold_expires_at timestamptz not null,
    confirmed_at    timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
-- C2: one live booking per plot, one open checkout per user
create unique index ux_live_booking_per_plot on booking (plot_id) where status in ('PENDING_PAYMENT', 'CONFIRMED');
create unique index ux_pending_booking_per_user on booking (user_id) where status = 'PENDING_PAYMENT';
create index ix_booking_user on booking (user_id, created_at desc);

create table payment (
    id                  uuid primary key default gen_random_uuid(),
    internal_ref        text not null unique,
    booking_id          uuid not null references booking (id),
    user_id             uuid not null references app_user (id),
    amount_paise        bigint not null,
    status              text not null check (status in
        ('CREATED', 'PENDING', 'VERIFIED', 'FAILED', 'REFUND_PENDING', 'REFUNDED')),
    provider            text not null default 'razorpay',
    provider_order_id   text unique,
    provider_payment_id text unique,
    provider_refund_id  text,
    failure_reason      text,
    verified_at         timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);
create index ix_payment_user on payment (user_id, created_at desc);
create index ix_payment_booking on payment (booking_id);

create table webhook_event (
    id                bigserial primary key,
    provider          text not null,
    provider_event_id text not null,
    payload           jsonb,
    received_at       timestamptz not null default now(),
    unique (provider, provider_event_id)
);

-- Ledger: append-only. Status lives in ledger_entry_status history.
create table ledger_entry (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid not null references app_user (id),
    kind                text not null check (kind in ('COMMISSION', 'MATCHING')),
    level               int check (level between 1 and 3),
    source_booking_id   uuid references booking (id),
    source_match_run_id uuid,
    gross_paise         bigint not null,
    admin_paise         bigint not null,
    tds_paise           bigint not null,
    net_paise           bigint not null,
    reverses_id         uuid references ledger_entry (id),
    created_at          timestamptz not null default now(),
    check (gross_paise = admin_paise + tds_paise + net_paise)
);
create unique index ux_commission on ledger_entry (source_booking_id, user_id, level)
    where kind = 'COMMISSION' and reverses_id is null;
create unique index ux_reversal on ledger_entry (reverses_id) where reverses_id is not null;
create index ix_ledger_user on ledger_entry (user_id, created_at desc);

create function ledger_immutable() returns trigger language plpgsql as $$
begin
    raise exception 'ledger_entry is append-only';
end $$;
create trigger trg_ledger_immutable before update or delete on ledger_entry
    for each row execute function ledger_immutable();

create table ledger_entry_status (
    id              bigserial primary key,
    ledger_entry_id uuid not null references ledger_entry (id),
    status          text not null check (status in ('PENDING', 'ELIGIBLE', 'APPROVED', 'PAID', 'ON_HOLD', 'REVERSED')),
    actor_id        uuid references app_user (id),
    note            text,
    created_at      timestamptz not null default now()
);
create index ix_ledger_status on ledger_entry_status (ledger_entry_id, id desc);

create trigger trg_ledger_status_immutable before update or delete on ledger_entry_status
    for each row execute function ledger_immutable();

create view ledger_view as
select e.*, s.status, s.created_at as status_at
from ledger_entry e
join lateral (select status, created_at from ledger_entry_status
              where ledger_entry_id = e.id order by id desc limit 1) s on true;

create table match_volume (
    user_id     uuid primary key references app_user (id),
    left_paise  bigint not null default 0,
    right_paise bigint not null default 0,
    left_used   bigint not null default 0,
    right_used  bigint not null default 0
);

create table match_run (
    id             uuid primary key default gen_random_uuid(),
    user_id        uuid not null references app_user (id),
    left_used      bigint not null,
    right_used     bigint not null,
    matched_paise  bigint not null,
    bonus_paise    bigint not null,
    created_at     timestamptz not null default now()
);
alter table ledger_entry add foreign key (source_match_run_id) references match_run (id);

create table beneficiary (
    user_id          uuid primary key references app_user (id),
    holder_name      text not null,
    account_enc      bytea not null,
    account_last4    text not null,
    ifsc             text not null,
    pan_enc          bytea not null,
    pan_last4        text not null,
    provider_bene_id text not null,
    status           text not null check (status in ('VERIFIED', 'FAILED')),
    updated_at       timestamptz not null default now()
);

create table payout (
    id                   uuid primary key default gen_random_uuid(),
    internal_ref         text not null unique,
    user_id              uuid not null references app_user (id),
    amount_paise         bigint not null check (amount_paise > 0),
    status               text not null check (status in ('REQUESTED', 'PROCESSING', 'PAID', 'FAILED')),
    provider_transfer_id text,
    failure_reason       text,
    created_by           uuid not null references app_user (id),
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now()
);
create index ix_payout_user on payout (user_id, created_at desc);

create table payout_item (
    payout_id       uuid not null references payout (id),
    ledger_entry_id uuid not null references ledger_entry (id),
    failed          boolean not null default false,
    primary key (payout_id, ledger_entry_id)
);
-- FR-8.3: one ledger entry in at most one non-failed payout
create unique index ux_payout_item_live on payout_item (ledger_entry_id) where not failed;

create table document (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references app_user (id),
    booking_id  uuid references booking (id),
    type        text not null check (type in ('AGREEMENT', 'RECEIPT', 'ALLOTMENT', 'OTHER')),
    title       text not null,
    status      text not null check (status in ('PENDING', 'SENT', 'SIGNED', 'REJECTED', 'EXPIRED')),
    storage_key text not null,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index ix_document_user on document (user_id, created_at desc);

create table notification (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references app_user (id),
    category   text not null,
    title      text not null,
    body       text not null,
    deep_link  text,
    read_at    timestamptz,
    created_at timestamptz not null default now()
);
create index ix_notification_user on notification (user_id, created_at desc);

create table job (
    id         bigserial primary key,
    type       text not null,
    payload    jsonb not null,
    run_at     timestamptz not null default now(),
    attempts   int not null default 0,
    last_error text,
    done_at    timestamptz,
    dead       boolean not null default false
);
create index ix_job_pending on job (run_at) where done_at is null;

create table audit_log (
    id         bigserial primary key,
    actor_id   uuid references app_user (id),
    action     text not null,
    entity     text not null,
    entity_id  text,
    before     jsonb,
    after      jsonb,
    created_at timestamptz not null default now()
);
create index ix_audit_entity on audit_log (entity, entity_id);
