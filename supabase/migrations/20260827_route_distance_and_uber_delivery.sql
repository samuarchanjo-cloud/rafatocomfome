-- Distância operacional por rota, Uber Entrega e RPC privado para a Edge Function.
-- place_order e place_order_v2 permanecem inalterados para compatibilidade.

begin;

alter table public.orders
  add column if not exists delivery_mode text,
  add column if not exists route_source text,
  add column if not exists route_duration_minutes numeric(10,2);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_delivery_mode_valid'
  ) then
    alter table public.orders add constraint orders_delivery_mode_valid
      check (delivery_mode is null or delivery_mode in ('own_delivery', 'uber'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_route_source_valid'
  ) then
    alter table public.orders add constraint orders_route_source_valid
      check (route_source is null or route_source in ('openrouteservice', 'haversine_fallback'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_route_duration_valid'
  ) then
    alter table public.orders add constraint orders_route_duration_valid
      check (route_duration_minutes is null or route_duration_minutes > 0);
  end if;
end $$;

-- Valores comerciais iniciais solicitados, sem substituir valores já configurados.
update public.app_settings
set
  below_one_km_behavior = 'fixed',
  below_one_km_fee = coalesce(below_one_km_fee, 3.00),
  maximum_delivery_distance_km = coalesce(maximum_delivery_distance_km, 3.50)
where id = 'global';

insert into public.delivery_fee_ranges (min_distance_km, max_distance_km, fee, active)
select 1.00, settings.maximum_delivery_distance_km, 5.00, true
from public.app_settings settings
where settings.id = 'global'
  and settings.maximum_delivery_distance_km > 1.00
  and not exists (select 1 from public.delivery_fee_ranges where active);

-- A instalação atual usa uma única faixa normal. Elimina o antigo intervalo
-- comercial de 1,00 a 1,10 km sem substituir a taxa já cadastrada pelo Admin.
update public.delivery_fee_ranges range
set
  min_distance_km = 1.00,
  max_distance_km = settings.maximum_delivery_distance_km
from public.app_settings settings
where settings.id = 'global'
  and settings.maximum_delivery_distance_km > 1.00
  and range.active
  and (select count(*) from public.delivery_fee_ranges where active) = 1;

create or replace function public.place_order_v3(p_order jsonb, p_route jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings public.app_settings%rowtype;
  v_delivery_area record;
  v_item jsonb;
  v_product public.products%rowtype;
  v_items jsonb := '[]'::jsonb;
  v_quantity integer;
  v_subtotal numeric(10,2) := 0;
  v_delivery_fee numeric(10,2) := 0;
  v_card_fee numeric(10,2) := 0;
  v_total numeric(10,2) := 0;
  v_haversine_distance numeric(8,2);
  v_distance numeric(8,2);
  v_route_duration_minutes numeric(10,2);
  v_route_source text := nullif(trim(coalesce(p_route->>'source', '')), '');
  v_order_id uuid;
  v_delivery_type text := p_order->>'delivery_type';
  v_delivery_mode text := nullif(trim(coalesce(p_order->>'delivery_mode', '')), '');
  v_payment_method text := p_order->>'payment_method';
  v_latitude numeric;
  v_longitude numeric;
  v_postal_code text;
  v_location_source text := nullif(trim(coalesce(p_order->>'location_source', '')), '');
begin
  if not public.is_business_open(now()) then raise exception 'STORE_CLOSED'; end if;
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
    if v_delivery_mode not in ('own_delivery', 'uber') then raise exception 'INVALID_DELIVERY_MODE'; end if;
    if v_location_source not in ('nominatim_exact', 'nominatim_street', 'postal_zone') then
      raise exception 'INVALID_LOCATION_SOURCE';
    end if;

    if v_location_source = 'postal_zone' then
      if v_delivery_mode <> 'own_delivery' then raise exception 'INVALID_DELIVERY_MODE'; end if;
      v_postal_code := regexp_replace(coalesce(p_order->>'postal_code', ''), '[^0-9]', '', 'g');
      if length(v_postal_code) <> 8 then raise exception 'DELIVERY_ZONE_NOT_FOUND'; end if;
      select area.* into v_delivery_area
      from public.resolve_delivery_area(v_postal_code, null) area;
      if not found then raise exception 'DELIVERY_ZONE_NOT_FOUND'; end if;

      v_latitude := null;
      v_longitude := null;
      v_haversine_distance := null;
      v_distance := null;
      v_route_source := null;
      v_route_duration_minutes := null;
      v_delivery_fee := v_delivery_area.delivery_fee;
    else
      begin
        v_latitude := (p_order->>'latitude')::numeric;
        v_longitude := (p_order->>'longitude')::numeric;
        v_distance := round((p_route->>'distance_km')::numeric, 2);
        if nullif(trim(coalesce(p_route->>'duration_minutes', '')), '') is not null then
          v_route_duration_minutes := round((p_route->>'duration_minutes')::numeric, 2);
        end if;
      exception when others then
        raise exception 'LOCATION_REQUIRED';
      end;
      if v_latitude is null or v_longitude is null
         or v_latitude not between -90 and 90 or v_longitude not between -180 and 180 then
        raise exception 'LOCATION_REQUIRED';
      end if;
      if v_distance is null or v_distance < 0
         or v_route_source not in ('openrouteservice', 'haversine_fallback') then
        raise exception 'INVALID_ROUTE_DISTANCE';
      end if;
      if v_route_source = 'openrouteservice'
         and (v_route_duration_minutes is null or v_route_duration_minutes <= 0) then
        raise exception 'INVALID_ROUTE_DURATION';
      end if;
      if v_route_source = 'haversine_fallback' then v_route_duration_minutes := null; end if;

      v_haversine_distance := round(public.haversine_distance_km(
        v_settings.store_latitude, v_settings.store_longitude, v_latitude, v_longitude
      ), 2);
      if v_distance + 0.10 < v_haversine_distance then raise exception 'INVALID_ROUTE_DISTANCE'; end if;
      if v_settings.maximum_delivery_distance_km is null then raise exception 'DELIVERY_NOT_CONFIGURED'; end if;

      if v_distance > v_settings.maximum_delivery_distance_km then
        if v_delivery_mode <> 'uber' then raise exception 'OUTSIDE_DELIVERY_AREA'; end if;
        v_delivery_fee := 0;
      else
        if v_delivery_mode = 'uber' then raise exception 'UBER_NOT_AVAILABLE'; end if;
        if v_distance <= 1.00 then
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
    end if;
  else
    v_delivery_mode := null;
    v_location_source := null;
    v_postal_code := null;
    v_latitude := null;
    v_longitude := null;
    v_haversine_distance := null;
    v_distance := null;
    v_route_source := null;
    v_route_duration_minutes := null;
  end if;

  if v_payment_method in ('credito', 'debito') then
    v_card_fee := round((v_subtotal + v_delivery_fee) * v_settings.card_fee_percent / 100, 2);
  end if;
  v_total := v_subtotal + v_delivery_fee + v_card_fee;

  insert into public.orders (
    customer_name, customer_phone, address, reference, delivery_type, delivery_mode,
    customer_latitude, customer_longitude, distance_km, route_source, route_duration_minutes,
    location_source, location_accuracy_m, location_uncertainty_m,
    payment_method, needs_change, change_for, notes,
    subtotal, delivery_fee, card_fee, total
  ) values (
    trim(p_order->>'customer_name'), trim(p_order->>'customer_phone'),
    nullif(trim(p_order->>'address'), ''), nullif(trim(p_order->>'reference'), ''),
    v_delivery_type, v_delivery_mode,
    v_latitude, v_longitude, v_distance, v_route_source, v_route_duration_minutes,
    v_location_source, null, null,
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
    'route_source', v_route_source,
    'route_duration_minutes', v_route_duration_minutes,
    'delivery_mode', v_delivery_mode,
    'location_source', v_location_source,
    'postal_code', v_postal_code,
    'subtotal', v_subtotal,
    'delivery_fee', v_delivery_fee,
    'card_fee', v_card_fee,
    'total', v_total
  );
end;
$$;

revoke all on function public.place_order_v3(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.place_order_v3(jsonb, jsonb) to service_role;

commit;
