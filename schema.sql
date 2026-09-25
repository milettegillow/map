-- The Scratch Map — Supabase schema
-- Paste this into the Supabase SQL editor and run it.
-- Safe to re-run.

-- ---------------------------------------------------------------- tables

create table if not exists public.profiles (
  id            uuid primary key references auth.users on delete cascade,
  birth_year    int not null,
  birth_country text,
  created_at    timestamptz default now()
);

create table if not exists public.visits (
  user_id     uuid references auth.users on delete cascade,
  country     text not null,
  visit_count int not null check (visit_count between 1 and 4), -- 4 means "4+"
  first_year  int,
  updated_at  timestamptz default now(),
  primary key (user_id, country)
);

-- ------------------------------------------------------------------ rls

alter table public.profiles enable row level security;
alter table public.visits   enable row level security;

drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
drop policy if exists profiles_delete_own on public.profiles;

create policy profiles_select_own on public.profiles
  for select using (auth.uid() = id);
create policy profiles_insert_own on public.profiles
  for insert with check (auth.uid() = id);
create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);
create policy profiles_delete_own on public.profiles
  for delete using (auth.uid() = id);

drop policy if exists visits_select_own on public.visits;
drop policy if exists visits_insert_own on public.visits;
drop policy if exists visits_update_own on public.visits;
drop policy if exists visits_delete_own on public.visits;

create policy visits_select_own on public.visits
  for select using (auth.uid() = user_id);
create policy visits_insert_own on public.visits
  for insert with check (auth.uid() = user_id);
create policy visits_update_own on public.visits
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy visits_delete_own on public.visits
  for delete using (auth.uid() = user_id);

-- ------------------------------------------------------------ aggregates
-- These are the only way anyone sees anyone else's data, and they return
-- nothing but per-country counts and means. No emails, no individual rows.

create or replace function public.group_stats()
returns table (
  country     text,
  visitors    bigint,
  mean_visits numeric,
  mean_age    numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.country,
    count(*)::bigint as visitors,
    round(avg(v.visit_count), 1) as mean_visits,
    round(
      avg(v.first_year - p.birth_year) filter (where v.first_year is not null),
      1
    ) as mean_age
  from public.visits v
  join public.profiles p on p.id = v.user_id
  group by v.country;
$$;

create or replace function public.traveller_count()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::bigint from public.profiles;
$$;

revoke all on function public.group_stats()     from public;
revoke all on function public.traveller_count() from public;

grant execute on function public.group_stats()     to anon, authenticated;
grant execute on function public.traveller_count() to anon, authenticated;
