-- Rafa, tô com fome — migração incremental e não destrutiva.
-- Revisado contra o banco em 20/07/2026: public.products já existe com 37 linhas.
-- PREMISSAS OBRIGATÓRIAS:
--   * public.products não é criada, renomeada, truncada ou recriada;
--   * nenhuma linha de public.products é inserida, atualizada ou excluída;
--   * id, name, description, price, category, image_url, status e visible não são alterados;
--   * products.category continua sendo texto e não recebe chave estrangeira.
-- Antes de executar, rode as consultas de verificação documentadas no fim deste arquivo
-- e exporte public.products como CSV.

begin;

-- Falha antes de qualquer DDL se for executada no projeto errado ou sem a tabela legada.
do $$
begin
  if to_regclass('public.products') is null then
    raise exception 'ABORTED: public.products precisa existir antes desta migração';
  end if;
end $$;

-- Snapshot temporário dos campos legados. A comparação antes do COMMIT garante rollback
-- integral caso qualquer uma dessas informações ou a quantidade de linhas seja alterada.
create temporary table migration_products_guard on commit drop as
select
  count(*)::bigint as row_count,
  md5(coalesce(string_agg(
    jsonb_build_array(id, name, description, price, category, image_url, status, visible)::text,
    '|' order by id
  ), '')) as protected_checksum
from public.products;

do $$
declare
  v_count bigint;
begin
  select row_count into v_count from migration_products_guard;
  if v_count <> 37 then
    raise exception 'ABORTED: eram esperados 37 produtos, mas foram encontrados %', v_count;
  end if;
end $$;

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Categories é um catálogo administrativo. products.category permanece texto, sem FK,
-- preservando integralmente os valores legados e a compatibilidade do cardápio atual.
create table if not exists public.categories (
  id text primary key,
  name text not null check (length(trim(name)) > 0),
  description text not null default '',
  banner_url text not null default '',
  sort_order integer not null default 0 check (sort_order >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.categories (id, name, description, banner_url, sort_order, active)
select seed.*
from (values
  ('combos', 'Combos', 'As melhores combinações para matar a fome.', 'https://res.cloudinary.com/ddc8f5ani/image/upload/f_auto,q_auto/banner_combos_opyqqk', 1, true),
  ('hamburgueres', 'Hambúrgueres', 'Montados do jeito que a fome merece.', 'https://res.cloudinary.com/ddc8f5ani/image/upload/f_auto,q_auto/banne_hamburguer_oev7ts', 2, true),
  ('pasteis', 'Pastéis', 'Crocantes por fora, recheados por dentro.', 'https://res.cloudinary.com/ddc8f5ani/image/upload/f_auto,q_auto/banner_pasteis_svicgt', 3, true),
  ('porcoes', 'Porções', 'Perfeitas para compartilhar.', 'https://res.cloudinary.com/ddc8f5ani/image/upload/f_auto,q_auto/banner_por%C3%A7%C3%B5es_ultb2k', 4, true),
  ('bebidas', 'Bebidas', 'A companhia perfeita para seu pedido.', 'https://res.cloudinary.com/ddc8f5ani/image/upload/f_auto,q_auto/BANNER_BEBIDAS_gxdtxj', 5, true)
) as seed(id, name, description, banner_url, sort_order, active)
where exists (select 1 from public.products p where p.category = seed.id)
on conflict (id) do nothing;

-- Únicas alterações estruturais em products. Nenhum UPDATE é executado.
-- sort_order é necessário para ordenação administrativa e featured para destaques.
alter table public.products add column if not exists featured boolean not null default false;
alter table public.products add column if not exists sort_order integer not null default 0;

create index if not exists products_category_sort_idx on public.products(category, sort_order, name);
create index if not exists products_public_idx on public.products(visible, status);
create index if not exists categories_active_sort_idx on public.categories(active, sort_order);

-- Horários independentes por dia. 0=domingo, 1=segunda, ... 6=sábado.
create table if not exists public.business_hours (
  day_of_week smallint primary key check (day_of_week between 0 and 6),
  is_open boolean not null default false,
  opening_time time,
  closing_time time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_hours_times_required check (
    (not is_open) or (opening_time is not null and closing_time is not null)
  )
);

insert into public.business_hours (day_of_week, is_open, opening_time, closing_time)
values
  (0, true, '19:00', '23:00'),
  (1, false, null, null),
  (2, false, null, null),
  (3, true, '19:00', '23:00'),
  (4, true, '19:00', '23:00'),
  (5, true, '19:00', '23:00'),
  (6, true, '19:00', '23:00')
on conflict (day_of_week) do nothing;

-- Nenhum valor de entrega é inventado: inicialmente não há faixas e entregas ficam bloqueadas.
create table if not exists public.delivery_fee_ranges (
  id uuid primary key default gen_random_uuid(),
  min_distance_km numeric(8,2) not null check (min_distance_km >= 1),
  max_distance_km numeric(8,2) not null,
  fee numeric(10,2) not null check (fee >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint delivery_range_order check (min_distance_km <= max_distance_km)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'delivery_fee_ranges_no_overlap') then
    alter table public.delivery_fee_ranges
      add constraint delivery_fee_ranges_no_overlap
      exclude using gist (numrange(min_distance_km, max_distance_km, '[]') with &&)
      where (active);
  end if;
end $$;

create index if not exists delivery_fee_ranges_active_idx
  on public.delivery_fee_ranges(active, min_distance_km, max_distance_km);

create table if not exists public.app_settings (
  id text primary key default 'global' check (id = 'global'),
  store_name text not null default 'Rafa, tô com fome',
  whatsapp_number text not null default '5521981720710',
  pix_key text not null default '',
  pix_name text not null default '',
  pix_qr_code_url text not null default '',
  brand_logo_url text not null default '',
  brand_hero_url text not null default '',
  timezone text not null default 'America/Sao_Paulo',
  store_latitude numeric(10,7) not null check (store_latitude between -90 and 90),
  store_longitude numeric(10,7) not null check (store_longitude between -180 and 180),
  below_one_km_behavior text not null default 'blocked'
    check (below_one_km_behavior in ('free', 'fixed', 'blocked')),
  below_one_km_fee numeric(10,2) check (below_one_km_fee is null or below_one_km_fee >= 0),
  maximum_delivery_distance_km numeric(8,2)
    check (maximum_delivery_distance_km is null or maximum_delivery_distance_km > 0),
  card_fee_percent numeric(6,2) not null default 5 check (card_fee_percent >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint below_one_km_fixed_fee_required check (
    below_one_km_behavior <> 'fixed' or below_one_km_fee is not null
  )
);

insert into public.app_settings (
  id, store_name, whatsapp_number, pix_key, pix_name, pix_qr_code_url,
  brand_logo_url, brand_hero_url, timezone, store_latitude, store_longitude,
  below_one_km_behavior, below_one_km_fee, maximum_delivery_distance_km, card_fee_percent
)
values (
  'global', 'Rafa, tô com fome', '5521981720710', '43577769000180',
  'Rafaela Sardinha Ferreira',
  'https://res.cloudinary.com/ddc8f5ani/image/upload/f_auto,q_auto/qrcode-pix_1_rilq1x',
  'https://res.cloudinary.com/ddc8f5ani/image/upload/f_auto,q_auto/logo_fih38z',
  'https://res.cloudinary.com/ddc8f5ani/image/upload/f_auto,q_auto/banner_principal_ubjelk',
  'America/Sao_Paulo', -22.9438007, -43.5824387,
  'blocked', null, null, 5
)
on conflict (id) do nothing;

-- Lista explícita de administradores vinculada a Supabase Auth.
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (select 1 from public.app_admins where user_id = auth.uid());
$$;

-- Pedidos só podem ser criados pela função transacional place_order.
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  customer_phone text not null,
  address text,
  reference text,
  delivery_type text not null check (delivery_type in ('entrega', 'retirada')),
  customer_latitude numeric(10,7),
  customer_longitude numeric(10,7),
  distance_km numeric(8,2),
  payment_method text not null check (payment_method in ('pix', 'dinheiro', 'credito', 'debito')),
  needs_change boolean not null default false,
  change_for text,
  notes text,
  subtotal numeric(10,2) not null check (subtotal >= 0),
  delivery_fee numeric(10,2) not null default 0 check (delivery_fee >= 0),
  card_fee numeric(10,2) not null default 0 check (card_fee >= 0),
  total numeric(10,2) not null check (total >= 0),
  status text not null default 'novo' check (status in ('novo', 'confirmado', 'preparando', 'saiu_para_entrega', 'concluido', 'cancelado')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  -- Snapshot textual: propositalmente sem FK para não impor mudanças à tabela legada products.
  product_id text,
  product_name text not null,
  unit_price numeric(10,2) not null check (unit_price >= 0),
  quantity integer not null check (quantity between 1 and 50),
  line_total numeric(10,2) not null check (line_total >= 0),
  created_at timestamptz not null default now()
);

create index if not exists orders_created_at_idx on public.orders(created_at desc);
create index if not exists orders_status_idx on public.orders(status, created_at desc);
create index if not exists order_items_order_id_idx on public.order_items(order_id);

create or replace function public.is_business_open(p_at timestamptz default now())
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_timezone text;
  v_local timestamp;
  v_day integer;
  v_time time;
  v_today public.business_hours%rowtype;
  v_yesterday public.business_hours%rowtype;
begin
  select timezone into v_timezone from public.app_settings where id = 'global';
  v_timezone := coalesce(v_timezone, 'America/Sao_Paulo');
  v_local := p_at at time zone v_timezone;
  v_day := extract(dow from v_local)::integer;
  v_time := v_local::time;

  select * into v_today from public.business_hours where day_of_week = v_day;
  if found and v_today.is_open then
    if v_today.opening_time = v_today.closing_time then return true; end if;
    if v_today.closing_time > v_today.opening_time
       and v_time >= v_today.opening_time and v_time < v_today.closing_time then return true; end if;
    if v_today.closing_time < v_today.opening_time and v_time >= v_today.opening_time then return true; end if;
  end if;

  select * into v_yesterday from public.business_hours where day_of_week = ((v_day + 6) % 7);
  return found and v_yesterday.is_open
    and v_yesterday.closing_time < v_yesterday.opening_time
    and v_time < v_yesterday.closing_time;
end;
$$;

create or replace function public.haversine_distance_km(
  p_latitude_1 numeric, p_longitude_1 numeric,
  p_latitude_2 numeric, p_longitude_2 numeric
)
returns numeric
language sql
immutable
strict
set search_path = public
as $$
  select 6371 * 2 * asin(sqrt(
    power(sin(radians((p_latitude_2 - p_latitude_1) / 2)), 2) +
    cos(radians(p_latitude_1)) * cos(radians(p_latitude_2)) *
    power(sin(radians((p_longitude_2 - p_longitude_1) / 2)), 2)
  ));
$$;

create or replace function public.place_order(p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings public.app_settings%rowtype;
  v_item jsonb;
  v_product public.products%rowtype;
  v_items jsonb := '[]'::jsonb;
  v_quantity integer;
  v_subtotal numeric(10,2) := 0;
  v_delivery_fee numeric(10,2) := 0;
  v_card_fee numeric(10,2) := 0;
  v_total numeric(10,2) := 0;
  v_distance numeric(8,2);
  v_order_id uuid;
  v_delivery_type text := p_order->>'delivery_type';
  v_payment_method text := p_order->>'payment_method';
  v_latitude numeric;
  v_longitude numeric;
begin
  if not public.is_business_open(now()) then
    raise exception 'STORE_CLOSED';
  end if;
  if jsonb_typeof(p_order->'items') <> 'array' or jsonb_array_length(p_order->'items') = 0 then
    raise exception 'EMPTY_ORDER';
  end if;
  if length(trim(coalesce(p_order->>'customer_name', ''))) < 2
     or length(trim(coalesce(p_order->>'customer_phone', ''))) < 8 then
    raise exception 'INVALID_CUSTOMER';
  end if;
  if v_delivery_type not in ('entrega', 'retirada') then raise exception 'INVALID_DELIVERY_TYPE'; end if;
  if v_payment_method not in ('pix', 'dinheiro', 'credito', 'debito') then raise exception 'INVALID_PAYMENT'; end if;

  select * into strict v_settings from public.app_settings where id = 'global';

  for v_item in select * from jsonb_array_elements(p_order->'items') loop
    v_quantity := (v_item->>'quantity')::integer;
    if v_quantity < 1 or v_quantity > 50 then raise exception 'INVALID_QUANTITY'; end if;
    select * into v_product from public.products where id = v_item->>'product_id';
    if not found
       or not coalesce(v_product.visible, false)
       or lower(trim(v_product.status)) not in ('disponível', 'disponivel') then
      raise exception 'PRODUCT_UNAVAILABLE:%', v_item->>'product_id';
    end if;
    v_subtotal := v_subtotal + (v_product.price * v_quantity);
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id,
      'name', v_product.name,
      'unit_price', v_product.price,
      'quantity', v_quantity,
      'line_total', v_product.price * v_quantity
    ));
  end loop;

  if v_delivery_type = 'entrega' then
    if length(trim(coalesce(p_order->>'address', ''))) < 5 then raise exception 'INVALID_ADDRESS'; end if;
    begin
      v_latitude := (p_order->>'latitude')::numeric;
      v_longitude := (p_order->>'longitude')::numeric;
    exception when others then
      raise exception 'LOCATION_REQUIRED';
    end;
    if v_latitude is null or v_longitude is null
       or v_latitude not between -90 and 90 or v_longitude not between -180 and 180 then
      raise exception 'LOCATION_REQUIRED';
    end if;
    v_distance := round(public.haversine_distance_km(
      v_settings.store_latitude, v_settings.store_longitude, v_latitude, v_longitude
    ), 2);
    if v_settings.maximum_delivery_distance_km is null then raise exception 'DELIVERY_NOT_CONFIGURED'; end if;
    if v_distance > v_settings.maximum_delivery_distance_km then raise exception 'OUTSIDE_DELIVERY_AREA'; end if;

    if v_distance < 1 then
      if v_settings.below_one_km_behavior = 'blocked' then raise exception 'BELOW_ONE_KM_BLOCKED'; end if;
      if v_settings.below_one_km_behavior = 'fixed' then
        if v_settings.below_one_km_fee is null then raise exception 'DELIVERY_NOT_CONFIGURED'; end if;
        v_delivery_fee := v_settings.below_one_km_fee;
      else
        v_delivery_fee := 0;
      end if;
    else
      select fee into v_delivery_fee
      from public.delivery_fee_ranges
      where active and v_distance between min_distance_km and max_distance_km
      order by min_distance_km
      limit 1;
      if not found then raise exception 'NO_DELIVERY_RANGE'; end if;
    end if;
  end if;

  if v_payment_method in ('credito', 'debito') then
    v_card_fee := round((v_subtotal + v_delivery_fee) * v_settings.card_fee_percent / 100, 2);
  end if;
  v_total := v_subtotal + v_delivery_fee + v_card_fee;

  insert into public.orders (
    customer_name, customer_phone, address, reference, delivery_type,
    customer_latitude, customer_longitude, distance_km,
    payment_method, needs_change, change_for, notes,
    subtotal, delivery_fee, card_fee, total
  ) values (
    trim(p_order->>'customer_name'), trim(p_order->>'customer_phone'),
    nullif(trim(p_order->>'address'), ''), nullif(trim(p_order->>'reference'), ''), v_delivery_type,
    v_latitude, v_longitude, v_distance,
    v_payment_method, coalesce((p_order->>'needs_change')::boolean, false),
    nullif(trim(p_order->>'change_for'), ''), nullif(trim(p_order->>'notes'), ''),
    v_subtotal, v_delivery_fee, v_card_fee, v_total
  ) returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(v_items) loop
    insert into public.order_items (order_id, product_id, product_name, unit_price, quantity, line_total)
    values (
      v_order_id, v_item->>'product_id', v_item->>'name',
      (v_item->>'unit_price')::numeric, (v_item->>'quantity')::integer, (v_item->>'line_total')::numeric
    );
  end loop;

  return jsonb_build_object(
    'id', v_order_id,
    'items', v_items,
    'distance_km', v_distance,
    'subtotal', v_subtotal,
    'delivery_fee', v_delivery_fee,
    'card_fee', v_card_fee,
    'total', v_total
  );
end;
$$;

-- updated_at somente nas novas tabelas editáveis.
do $$
declare
  v_table text;
begin
  -- products fica fora: a migração não substitui triggers preexistentes da tabela legada.
  foreach v_table in array array['categories','business_hours','delivery_fee_ranges','app_settings','orders'] loop
    execute format('drop trigger if exists %I on public.%I', 'set_' || v_table || '_updated_at', v_table);
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      'set_' || v_table || '_updated_at', v_table
    );
  end loop;
end $$;

-- RLS: leitura pública só do necessário; escrita exclusivamente para app_admins.
alter table public.products enable row level security;
alter table public.categories enable row level security;
alter table public.business_hours enable row level security;
alter table public.delivery_fee_ranges enable row level security;
alter table public.app_settings enable row level security;
alter table public.app_admins enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

-- Mantém intactas as políticas SELECT já existentes. Políticas RLS são permissivas
-- por OR, portanto esta política garante leitura pública dos produtos visíveis mesmo
-- que uma política legada seja mais restritiva.
drop policy if exists rafa_products_public_select on public.products;
drop policy if exists rafa_products_admin_select on public.products;
create policy rafa_products_public_select on public.products for select to anon, authenticated
  using (coalesce(visible, true));
create policy rafa_products_admin_select on public.products for select to authenticated
  using (public.is_admin());

-- Remove somente políticas de escrita da tabela products. Isso fecha o acesso anônimo
-- usado pelo admin antigo e o substitui por escrita autenticada + app_admins.
do $$
declare
  v_policy record;
begin
  for v_policy in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'products'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  loop
    execute format('drop policy %I on public.products', v_policy.policyname);
  end loop;
end $$;

create policy rafa_products_admin_insert on public.products for insert to authenticated
  with check (public.is_admin());
create policy rafa_products_admin_update on public.products for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy rafa_products_admin_delete on public.products for delete to authenticated
  using (public.is_admin());

-- Privilégios de tabela: leitura pública preservada; mutações só chegam ao papel authenticated.
revoke insert, update, delete on public.products from public, anon;
grant select on public.products to anon, authenticated;
grant insert, update, delete on public.products to authenticated;

drop policy if exists categories_public_read on public.categories;
drop policy if exists categories_admin_write on public.categories;
create policy categories_public_read on public.categories for select to anon, authenticated
  using (active or public.is_admin());
create policy categories_admin_write on public.categories for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists business_hours_public_read on public.business_hours;
drop policy if exists business_hours_admin_write on public.business_hours;
create policy business_hours_public_read on public.business_hours for select to anon, authenticated using (true);
create policy business_hours_admin_write on public.business_hours for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists delivery_ranges_public_read on public.delivery_fee_ranges;
drop policy if exists delivery_ranges_admin_write on public.delivery_fee_ranges;
create policy delivery_ranges_public_read on public.delivery_fee_ranges for select to anon, authenticated
  using (active or public.is_admin());
create policy delivery_ranges_admin_write on public.delivery_fee_ranges for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists app_settings_public_read on public.app_settings;
drop policy if exists app_settings_admin_write on public.app_settings;
create policy app_settings_public_read on public.app_settings for select to anon, authenticated using (true);
create policy app_settings_admin_write on public.app_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists app_admins_read_self on public.app_admins;
create policy app_admins_read_self on public.app_admins for select to authenticated
  using (user_id = auth.uid());

drop policy if exists orders_admin_read on public.orders;
drop policy if exists orders_admin_update on public.orders;
create policy orders_admin_read on public.orders for select to authenticated using (public.is_admin());
create policy orders_admin_update on public.orders for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists order_items_admin_read on public.order_items;
create policy order_items_admin_read on public.order_items for select to authenticated using (public.is_admin());

grant select on public.categories, public.business_hours, public.delivery_fee_ranges, public.app_settings
  to anon, authenticated;
grant insert, update, delete on public.categories, public.business_hours, public.delivery_fee_ranges, public.app_settings
  to authenticated;
grant select, update on public.orders to authenticated;
grant select on public.order_items to authenticated;

-- Bucket público somente para leitura; upload/alteração/exclusão requer administrador.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists product_images_public_read on storage.objects;
drop policy if exists product_images_admin_insert on storage.objects;
drop policy if exists product_images_admin_update on storage.objects;
drop policy if exists product_images_admin_delete on storage.objects;
create policy product_images_public_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'product-images');
create policy product_images_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and public.is_admin());
create policy product_images_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and public.is_admin())
  with check (bucket_id = 'product-images' and public.is_admin());
create policy product_images_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and public.is_admin());

revoke all on function public.place_order(jsonb) from public;
grant execute on function public.place_order(jsonb) to anon, authenticated;
grant execute on function public.is_business_open(timestamptz) to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;

-- Atualização automática do cardápio público. Ignora tabelas já publicadas.
do $$
declare
  v_table text;
begin
  foreach v_table in array array['products','categories','business_hours','delivery_fee_ranges','app_settings'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end $$;

-- Garantia final: nenhum registro nem campo legado de products pode ter mudado.
do $$
declare
  v_before migration_products_guard%rowtype;
  v_after_count bigint;
  v_after_checksum text;
begin
  select * into strict v_before from migration_products_guard;
  select
    count(*)::bigint,
    md5(coalesce(string_agg(
      jsonb_build_array(id, name, description, price, category, image_url, status, visible)::text,
      '|' order by id
    ), ''))
  into v_after_count, v_after_checksum
  from public.products;

  if v_after_count is distinct from v_before.row_count
     or v_after_checksum is distinct from v_before.protected_checksum then
    raise exception 'ABORTED: public.products sofreu alteração inesperada; toda a migração será revertida';
  end if;
end $$;

commit;

-- ETAPA MANUAL, após criar o usuário em Authentication > Users:
-- insert into public.app_admins (user_id) values ('UUID-DO-USUARIO-ADMIN');
