-- Cadastro opcional, endereços, histórico e metadata híbrida da localização.
-- Incremental: preserva pedidos, produtos, regras comerciais e RPCs anteriores.

begin;

create table if not exists public.customer_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) >= 2),
  phone text not null check (length(trim(phone)) >= 8),
  email text not null,
  last_order_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customer_profiles(id) on delete cascade,
  label text not null default 'Casa' check (length(trim(label)) > 0),
  street text not null check (length(trim(street)) > 0),
  number text not null check (length(trim(number)) > 0),
  complement text,
  reference text,
  neighborhood text,
  city text,
  state text,
  postcode text check (postcode is null or postcode ~ '^[0-9]{8}$'),
  latitude numeric(10,7) check (latitude is null or latitude between -90 and 90),
  longitude numeric(10,7) check (longitude is null or longitude between -180 and 180),
  location_source text not null check (location_source in ('gps', 'address')),
  location_accuracy numeric(8,2) check (location_accuracy is null or location_accuracy > 0),
  geocoding_source text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_address_coordinates_together check ((latitude is null) = (longitude is null)),
  constraint customer_address_gps_accuracy check (location_source <> 'gps' or (location_accuracy is not null and location_accuracy <= 150))
);

alter table public.orders
  add column if not exists customer_id uuid references public.customer_profiles(id) on delete set null,
  add column if not exists customer_address_id uuid references public.customer_addresses(id) on delete set null,
  add column if not exists geocoding_source text,
  add column if not exists address_street text,
  add column if not exists address_number text,
  add column if not exists address_complement text,
  add column if not exists address_neighborhood text,
  add column if not exists address_city text,
  add column if not exists address_state text,
  add column if not exists address_postcode text;

alter table public.orders drop constraint if exists orders_location_source_allowed;
alter table public.orders add constraint orders_location_source_allowed check (
  location_source is null or location_source in (
    'gps', 'address', 'device_gps', 'nominatim_exact', 'nominatim_street',
    'google_exact', 'map_pin', 'postal_zone', 'address_consensus'
  )
);
alter table public.orders drop constraint if exists orders_location_accuracy_valid;
alter table public.orders add constraint orders_location_accuracy_valid check (
  (location_source is null and location_accuracy_m is null)
  or (location_source in ('address', 'nominatim_exact', 'nominatim_street', 'google_exact', 'map_pin', 'postal_zone', 'address_consensus') and location_accuracy_m is null)
  or (location_source in ('gps', 'device_gps') and location_accuracy_m > 0 and location_accuracy_m <= 150)
);
alter table public.orders drop constraint if exists orders_location_uncertainty_valid;
alter table public.orders add constraint orders_location_uncertainty_valid check (
  (location_source is null and location_uncertainty_m is null)
  or (location_source in ('gps', 'address', 'device_gps', 'nominatim_exact', 'nominatim_street', 'google_exact', 'map_pin', 'postal_zone') and location_uncertainty_m is null)
  or (location_source = 'address_consensus' and location_uncertainty_m >= 750)
);

create index if not exists customer_addresses_customer_idx on public.customer_addresses(customer_id, is_default desc);
create unique index if not exists customer_addresses_one_default_idx on public.customer_addresses(customer_id) where is_default;
create index if not exists orders_customer_created_idx on public.orders(customer_id, created_at desc);

drop trigger if exists set_customer_profiles_updated_at on public.customer_profiles;
create trigger set_customer_profiles_updated_at before update on public.customer_profiles
for each row execute function public.set_updated_at();
drop trigger if exists set_customer_addresses_updated_at on public.customer_addresses;
create trigger set_customer_addresses_updated_at before update on public.customer_addresses
for each row execute function public.set_updated_at();

create or replace function public.customer_address_assign_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'CUSTOMER_REQUIRED'; end if;
  if not public.is_admin() or new.customer_id is null then
    new.customer_id := auth.uid();
  end if;
  if new.is_default then
    update public.customer_addresses set is_default = false
    where customer_id = new.customer_id and id is distinct from new.id and is_default;
  end if;
  return new;
end;
$$;

drop trigger if exists customer_addresses_assign_owner on public.customer_addresses;
create trigger customer_addresses_assign_owner before insert or update on public.customer_addresses
for each row execute function public.customer_address_assign_owner();

alter table public.customer_profiles enable row level security;
alter table public.customer_addresses enable row level security;

drop policy if exists customer_profiles_own_select on public.customer_profiles;
drop policy if exists customer_profiles_own_insert on public.customer_profiles;
drop policy if exists customer_profiles_own_update on public.customer_profiles;
create policy customer_profiles_own_select on public.customer_profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy customer_profiles_own_insert on public.customer_profiles for insert to authenticated
  with check (id = auth.uid());
create policy customer_profiles_own_update on public.customer_profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists customer_addresses_own_all on public.customer_addresses;
create policy customer_addresses_own_all on public.customer_addresses for all to authenticated
  using (customer_id = auth.uid() or public.is_admin())
  with check (customer_id = auth.uid() or public.is_admin());

drop policy if exists orders_customer_read on public.orders;
create policy orders_customer_read on public.orders for select to authenticated
  using (customer_id = auth.uid() or public.is_admin());
drop policy if exists order_items_customer_read on public.order_items;
create policy order_items_customer_read on public.order_items for select to authenticated
  using (exists (
    select 1 from public.orders own_order
    where own_order.id = order_items.order_id
      and (own_order.customer_id = auth.uid() or public.is_admin())
  ));

grant select, insert, update on public.customer_profiles to authenticated;
grant select, insert, update, delete on public.customer_addresses to authenticated;

create or replace function public.place_order_v4(
  p_order jsonb,
  p_route jsonb default '{}'::jsonb,
  p_actor_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_result jsonb;
  v_order_id uuid;
  v_address_id uuid;
  v_saved_address public.customer_addresses%rowtype;
  v_requested_source text := nullif(trim(coalesce(p_order->>'location_source', '')), '');
  v_geocoding_source text := nullif(trim(coalesce(p_order->>'geocoding_source', '')), '');
  v_core_source text;
  v_core_order jsonb := p_order;
  v_accuracy numeric;
  v_user_email text;
begin
  if p_actor_user_id is not null then
    select email into v_user_email from auth.users where id = p_actor_user_id;
    if not found then raise exception 'CUSTOMER_REQUIRED'; end if;
    insert into public.customer_profiles (id, name, phone, email)
    values (
      p_actor_user_id,
      trim(p_order->>'customer_name'),
      trim(p_order->>'customer_phone'),
      coalesce(v_user_email, '')
    )
    on conflict (id) do update set
      name = excluded.name,
      phone = excluded.phone,
      email = excluded.email;
  end if;

  begin
    v_address_id := nullif(trim(coalesce(p_order->>'customer_address_id', '')), '')::uuid;
  exception when others then
    raise exception 'CUSTOMER_ADDRESS_FORBIDDEN';
  end;
  if v_address_id is not null then
    if p_actor_user_id is null then raise exception 'CUSTOMER_REQUIRED'; end if;
    if p_order->>'delivery_type' <> 'entrega' then raise exception 'CUSTOMER_ADDRESS_FORBIDDEN'; end if;
    select * into v_saved_address from public.customer_addresses
    where id = v_address_id and customer_id = p_actor_user_id;
    if not found then raise exception 'CUSTOMER_ADDRESS_FORBIDDEN'; end if;
    if v_saved_address.latitude is not null and (
      abs(v_saved_address.latitude - (p_order->>'latitude')::numeric) > 0.000001
      or abs(v_saved_address.longitude - (p_order->>'longitude')::numeric) > 0.000001
    ) then
      raise exception 'CUSTOMER_ADDRESS_FORBIDDEN';
    end if;
  end if;

  if p_order->>'delivery_type' = 'entrega' then
    if v_requested_source not in ('gps', 'address') then raise exception 'INVALID_LOCATION_SOURCE'; end if;
    if v_requested_source = 'gps' then
      begin v_accuracy := (p_order->>'location_accuracy_m')::numeric;
      exception when others then raise exception 'INVALID_LOCATION_ACCURACY'; end;
      if v_accuracy is null or v_accuracy <= 0 or v_accuracy > 150 then raise exception 'INVALID_LOCATION_ACCURACY'; end if;
      v_core_source := 'nominatim_exact';
    else
      v_core_source := case
        when v_geocoding_source = 'postal_zone' then 'postal_zone'
        when v_geocoding_source = 'nominatim_street' then 'nominatim_street'
        else 'nominatim_exact'
      end;
    end if;
    v_core_order := jsonb_set(v_core_order, '{location_source}', to_jsonb(v_core_source));
  end if;

  v_result := public.place_order_v3(v_core_order, p_route);
  v_order_id := (v_result->>'id')::uuid;

  update public.orders set
    customer_id = p_actor_user_id,
    customer_address_id = v_address_id,
    location_source = case when delivery_type = 'entrega' then v_requested_source else null end,
    location_accuracy_m = case when v_requested_source = 'gps' then v_accuracy else null end,
    geocoding_source = case when delivery_type = 'entrega' then v_geocoding_source else null end,
    address_street = nullif(trim(p_order->>'street'), ''),
    address_number = nullif(trim(p_order->>'number'), ''),
    address_complement = nullif(trim(p_order->>'complement'), ''),
    address_neighborhood = nullif(trim(p_order->>'neighborhood'), ''),
    address_city = nullif(trim(p_order->>'city'), ''),
    address_state = nullif(trim(p_order->>'state'), ''),
    address_postcode = nullif(regexp_replace(coalesce(p_order->>'postal_code', ''), '[^0-9]', '', 'g'), '')
  where id = v_order_id;

  if p_actor_user_id is not null then
    update public.customer_profiles set last_order_at = now() where id = p_actor_user_id;
  end if;

  return v_result || jsonb_build_object(
    'customer_id', p_actor_user_id,
    'customer_address_id', v_address_id,
    'location_source', case when p_order->>'delivery_type' = 'entrega' then v_requested_source else null end,
    'geocoding_source', case when p_order->>'delivery_type' = 'entrega' then v_geocoding_source else null end
  );
end;
$$;

revoke all on function public.place_order_v4(jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.place_order_v4(jsonb, jsonb, uuid) to service_role;

commit;
