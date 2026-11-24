-- ============================================================
-- Parcel Desk: database setup
-- Run this once in Supabase: SQL Editor > New query > paste > Run
-- Safe to run again: it only adds what's missing.
-- ============================================================

-- Buildings -------------------------------------------------
create table if not exists public.buildings (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  code          text not null unique,          -- used in the resident sign-up link
  contact_email text,                          -- shown to residents for questions/removal
  created_at    timestamptz not null default now()
);

-- Staff (concierge logins, each linked to one building) -----
create table if not exists public.staff (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  building_id uuid not null references public.buildings(id) on delete cascade,
  name        text,
  created_at  timestamptz not null default now()
);

-- Residents -------------------------------------------------
-- approved_at is empty for public sign-ups until the concierge approves them.
-- Only approved residents get parcel emails.
create table if not exists public.residents (
  id          uuid primary key default gen_random_uuid(),
  building_id uuid not null references public.buildings(id) on delete cascade,
  flat        text not null,
  name        text not null,
  email       text not null,
  consent_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  approved_at timestamptz default now(),
  approved_by uuid references auth.users(id) on delete set null,
  unique (building_id, flat, email)
);
alter table public.residents add column if not exists approved_at timestamptz default now();
alter table public.residents add column if not exists approved_by uuid references auth.users(id) on delete set null;

-- Parcels ---------------------------------------------------
create table if not exists public.parcels (
  id           uuid primary key default gen_random_uuid(),
  building_id  uuid not null references public.buildings(id) on delete cascade,
  flat         text not null,
  carrier      text,
  size         text,
  note         text,
  code         text not null default lpad(floor(random() * 10000)::int::text, 4, '0'),
  logged_by    uuid default auth.uid() references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  notified_at  timestamptz,
  reminded_at  timestamptz,
  collected_at timestamptz,
  collected_by uuid references auth.users(id) on delete set null
);
create index if not exists parcels_waiting_idx
  on public.parcels (building_id) where collected_at is null;

-- Keep-alive table for the daily GitHub ping ----------------
create table if not exists public.keep_alive (id int primary key);
insert into public.keep_alive values (1) on conflict do nothing;

-- ============================================================
-- Helpers
-- ============================================================

-- Which building does the signed-in staff member belong to?
create or replace function public.my_building()
returns uuid
language sql stable security definer set search_path = public
as $$
  select building_id from public.staff where user_id = auth.uid()
$$;

-- Tidy up input and fill in who did what.
-- "Who" fields are set here from the login, so they can't be faked from the app.
create or replace function public.tidy_row()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.flat := upper(regexp_replace(trim(new.flat), '\s+', ' ', 'g'));
  if new.building_id is null then
    new.building_id := public.my_building();
  end if;

  if tg_table_name = 'residents' then
    new.email := lower(trim(new.email));
    new.name  := trim(new.name);
    if new.approved_at is null then
      new.approved_by := null;
    elsif tg_op = 'INSERT' or old.approved_at is null then
      new.approved_by := auth.uid();
    else
      new.approved_by := old.approved_by;
    end if;
  end if;

  if tg_table_name = 'parcels' then
    if tg_op = 'INSERT' then
      new.logged_by := auth.uid();
      new.collected_by := null;
    else
      new.logged_by := old.logged_by;
      new.created_at := old.created_at;
      if new.collected_at is null then
        new.collected_by := null;
      elsif old.collected_at is null then
        new.collected_by := auth.uid();
      else
        new.collected_by := old.collected_by;
      end if;
    end if;
  end if;

  return new;
end
$$;

drop trigger if exists residents_tidy on public.residents;
create trigger residents_tidy before insert or update on public.residents
  for each row execute function public.tidy_row();

drop trigger if exists parcels_tidy on public.parcels;
create trigger parcels_tidy before insert or update on public.parcels
  for each row execute function public.tidy_row();

-- ============================================================
-- Security: staff only ever see their own building
-- ============================================================
alter table public.buildings  enable row level security;
alter table public.staff      enable row level security;
alter table public.residents  enable row level security;
alter table public.parcels    enable row level security;
alter table public.keep_alive enable row level security;

-- Access is granted table by table, so this works whether or not
-- "Grant API access to new tables automatically" was ticked.

-- The public (not signed in) can't touch any table directly, only the keep-alive ping.
revoke all on public.buildings, public.staff, public.residents, public.parcels, public.keep_alive from anon;
grant select on public.keep_alive to anon;

-- Signed-in staff can read their building and staff record, but never change them.
-- They can manage residents and parcels (the policies below limit this to their own building).
revoke all on public.buildings, public.staff, public.residents, public.parcels, public.keep_alive from authenticated;
grant select on public.buildings, public.staff, public.keep_alive to authenticated;
grant select, insert, update, delete on public.residents, public.parcels to authenticated;

-- The email function runs with the server-only key and needs full access.
grant usage on schema public to anon, authenticated, service_role;
grant all on public.buildings, public.staff, public.residents, public.parcels, public.keep_alive to service_role;

drop policy if exists "staff read own building" on public.buildings;
create policy "staff read own building" on public.buildings
  for select to authenticated using (id = public.my_building());

drop policy if exists "staff read own record" on public.staff;
create policy "staff read own record" on public.staff
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "staff manage residents" on public.residents;
create policy "staff manage residents" on public.residents
  for all to authenticated
  using (building_id = public.my_building())
  with check (building_id = public.my_building());

drop policy if exists "staff manage parcels" on public.parcels;
create policy "staff manage parcels" on public.parcels
  for all to authenticated
  using (building_id = public.my_building())
  with check (building_id = public.my_building());

drop policy if exists "public ping" on public.keep_alive;
create policy "public ping" on public.keep_alive
  for select using (true);

-- ============================================================
-- Resident sign-up (public page, no login)
-- Residents can only ADD themselves, as "waiting for approval".
-- They can never read the list, and the reply never reveals
-- whether someone is already registered.
-- ============================================================

create or replace function public.building_info(p_code text)
returns table (name text, contact_email text)
language sql stable security definer set search_path = public
as $$
  select b.name, b.contact_email
  from public.buildings b
  where b.code = upper(trim(p_code))
$$;

create or replace function public.register_resident(
  p_code text, p_name text, p_flat text, p_email text
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  b uuid;
  f text;
begin
  select id into b from public.buildings where code = upper(trim(p_code));
  if b is null then return 'unknown_building'; end if;

  if length(trim(coalesce(p_name, ''))) < 2 or length(p_name) > 100 then
    return 'invalid_name';
  end if;
  if length(trim(coalesce(p_flat, ''))) < 1 or length(p_flat) > 20 then
    return 'invalid_flat';
  end if;
  if coalesce(p_email, '') !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(p_email) > 200 then
    return 'invalid_email';
  end if;

  -- Flood protection: cap sign-ups waiting for approval
  f := upper(regexp_replace(trim(p_flat), '\s+', ' ', 'g'));
  if (select count(*) from public.residents where building_id = b and approved_at is null) >= 100
     or (select count(*) from public.residents where building_id = b and flat = f and approved_at is null) >= 5 then
    return 'busy';
  end if;

  insert into public.residents (building_id, flat, name, email, approved_at)
  values (b, p_flat, p_name, p_email, null)
  on conflict (building_id, flat, email) do nothing;

  return 'ok';
end
$$;

-- Only these two functions are open to the public
revoke execute on function public.my_building() from public, anon;
grant execute on function public.my_building() to authenticated;
revoke execute on function public.building_info(text) from public;
revoke execute on function public.register_resident(text, text, text, text) from public;
grant execute on function public.building_info(text) to anon, authenticated;
grant execute on function public.register_resident(text, text, text, text) to anon, authenticated;
