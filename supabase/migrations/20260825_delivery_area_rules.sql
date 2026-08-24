begin;

alter table public.delivery_postal_zones
  add column if not exists match_type text,
  add column if not exists postal_prefix text,
  add column if not exists postal_code_start text,
  add column if not exists postal_code_end text,
  add column if not exists neighborhood text,
  add column if not exists priority integer not null default 0;

update public.delivery_postal_zones
set match_type = 'exact'
where match_type is null;

alter table public.delivery_postal_zones
  alter column match_type set default 'exact',
  alter column match_type set not null,
  alter column postal_code drop not null;

alter table public.delivery_postal_zones
  drop constraint if exists delivery_postal_zones_postal_code_key,
  drop constraint if exists delivery_postal_zones_match_type_allowed,
  drop constraint if exists delivery_postal_zones_rule_shape;

alter table public.delivery_postal_zones
  add constraint delivery_postal_zones_match_type_allowed
    check (match_type in ('exact', 'prefix', 'range', 'neighborhood')),
  add constraint delivery_postal_zones_rule_shape
    check (
      (
        match_type = 'exact'
        and postal_code ~ '^[0-9]{8}$'
        and postal_prefix is null
        and postal_code_start is null
        and postal_code_end is null
        and neighborhood is null
      )
      or (
        match_type = 'prefix'
        and postal_code is null
        and postal_prefix ~ '^[0-9]{1,8}$'
        and postal_code_start is null
        and postal_code_end is null
        and neighborhood is null
      )
      or (
        match_type = 'range'
        and postal_code is null
        and postal_prefix is null
        and postal_code_start ~ '^[0-9]{8}$'
        and postal_code_end ~ '^[0-9]{8}$'
        and postal_code_start <= postal_code_end
        and neighborhood is null
      )
      or (
        match_type = 'neighborhood'
        and postal_code is null
        and postal_prefix is null
        and postal_code_start is null
        and postal_code_end is null
        and length(trim(neighborhood)) > 0
      )
    );

create index if not exists delivery_postal_zones_active_prefix_idx
  on public.delivery_postal_zones(postal_prefix)
  where active and match_type = 'prefix';

create index if not exists delivery_postal_zones_active_range_idx
  on public.delivery_postal_zones(postal_code_start, postal_code_end)
  where active and match_type = 'range';

create index if not exists delivery_postal_zones_active_neighborhood_idx
  on public.delivery_postal_zones(neighborhood)
  where active and match_type = 'neighborhood';

create or replace function public.normalize_delivery_neighborhood(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select regexp_replace(
    trim(translate(
      lower(coalesce(p_value, '')),
      'áàâãäéèêëíìîïóòôõöúùûüç',
      'aaaaaeeeeiiiiooooouuuuc'
    )),
    '\s+',
    ' ',
    'g'
  );
$$;

create index if not exists delivery_postal_zones_active_neighborhood_normalized_idx
  on public.delivery_postal_zones(public.normalize_delivery_neighborhood(neighborhood))
  where active and match_type = 'neighborhood';

create or replace function public.resolve_delivery_area(
  p_postal_code text,
  p_neighborhood text default null
)
returns table (id uuid, delivery_fee numeric, match_type text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with request as (
    select
      regexp_replace(coalesce(p_postal_code, ''), '[^0-9]', '', 'g') as postal_code,
      public.normalize_delivery_neighborhood(p_neighborhood) as neighborhood
  )
  select zone.id, zone.delivery_fee, zone.match_type
  from public.delivery_postal_zones zone
  cross join request
  where zone.active
    and length(request.postal_code) = 8
    and (
      (zone.match_type = 'exact' and zone.postal_code = request.postal_code)
      or (
        zone.match_type = 'prefix'
        and left(request.postal_code, length(zone.postal_prefix)) = zone.postal_prefix
      )
      or (
        zone.match_type = 'range'
        and request.postal_code between zone.postal_code_start and zone.postal_code_end
      )
      or (
        zone.match_type = 'neighborhood'
        and request.neighborhood <> ''
        and public.normalize_delivery_neighborhood(zone.neighborhood) = request.neighborhood
      )
    )
  order by
    case zone.match_type
      when 'exact' then 1
      when 'prefix' then 2
      when 'range' then 3
      when 'neighborhood' then 4
    end,
    case zone.match_type
      when 'exact' then 8
      when 'prefix' then length(zone.postal_prefix)
      when 'range' then -((zone.postal_code_end::bigint) - (zone.postal_code_start::bigint))
      when 'neighborhood' then length(public.normalize_delivery_neighborhood(zone.neighborhood))
    end desc,
    zone.priority desc,
    zone.created_at asc,
    zone.id asc
  limit 1;
$$;

-- Compatibilidade temporária com o frontend anterior: regras baseadas somente
-- em CEP continuam resolvidas pela assinatura pública antiga.
create or replace function public.get_delivery_postal_zone(p_postal_code text)
returns table (postal_code text, delivery_fee numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    regexp_replace(coalesce(p_postal_code, ''), '[^0-9]', '', 'g') as postal_code,
    area.delivery_fee
  from public.resolve_delivery_area(p_postal_code, null) area;
$$;

revoke all on function public.normalize_delivery_neighborhood(text) from public;
revoke all on function public.resolve_delivery_area(text, text) from public;
grant execute on function public.resolve_delivery_area(text, text) to anon, authenticated;
revoke all on function public.get_delivery_postal_zone(text) from public;
grant execute on function public.get_delivery_postal_zone(text) to anon, authenticated;

create or replace function public.place_order_v2(p_order jsonb)
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
  v_raw_distance numeric(8,2);
  v_distance numeric(8,2);
  v_order_id uuid;
  v_delivery_type text := p_order->>'delivery_type';
  v_payment_method text := p_order->>'payment_method';
  v_latitude numeric;
  v_longitude numeric;
  v_postal_code text;
  v_neighborhood text;
  v_location_source text := nullif(trim(coalesce(p_order->>'location_source', '')), '');
  v_location_accuracy_m numeric;
  v_location_uncertainty_m numeric;
  v_map_pin_confirmed boolean := false;
  v_min_address_uncertainty_m constant numeric := 750;
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
    if v_location_source is null
       or v_location_source not in ('nominatim_exact', 'google_exact', 'device_gps', 'map_pin', 'address_consensus', 'postal_zone') then
      raise exception 'INVALID_LOCATION_SOURCE';
    end if;

    if v_location_source = 'postal_zone' then
      v_postal_code := regexp_replace(coalesce(p_order->>'postal_code', ''), '[^0-9]', '', 'g');
      v_neighborhood := trim(coalesce(p_order->>'neighborhood', ''));
      if length(v_postal_code) <> 8 then raise exception 'DELIVERY_ZONE_NOT_FOUND'; end if;

      select area.* into v_delivery_area
      from public.resolve_delivery_area(v_postal_code, v_neighborhood) area;
      if not found then raise exception 'DELIVERY_ZONE_NOT_FOUND'; end if;

      if nullif(trim(coalesce(p_order->>'location_accuracy_m', '')), '') is not null then
        raise exception 'INVALID_LOCATION_ACCURACY';
      end if;
      if nullif(trim(coalesce(p_order->>'location_uncertainty_m', '')), '') is not null then
        raise exception 'INVALID_LOCATION_UNCERTAINTY';
      end if;

      v_latitude := null;
      v_longitude := null;
      v_raw_distance := null;
      v_distance := null;
      v_delivery_fee := v_delivery_area.delivery_fee;
    else
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

      if v_location_source = 'device_gps' then
        begin
          v_location_accuracy_m := (p_order->>'location_accuracy_m')::numeric;
        exception when others then
          raise exception 'INVALID_LOCATION_ACCURACY';
        end;
        if v_location_accuracy_m is null
           or v_location_accuracy_m <= 0
           or v_location_accuracy_m > 150 then
          raise exception 'INVALID_LOCATION_ACCURACY';
        end if;
        if nullif(trim(coalesce(p_order->>'location_uncertainty_m', '')), '') is not null then
          raise exception 'INVALID_LOCATION_UNCERTAINTY';
        end if;
      elsif v_location_source = 'address_consensus' then
        if nullif(trim(coalesce(p_order->>'location_accuracy_m', '')), '') is not null then
          raise exception 'INVALID_LOCATION_ACCURACY';
        end if;
        begin
          v_location_uncertainty_m := (p_order->>'location_uncertainty_m')::numeric;
        exception when others then
          raise exception 'INVALID_LOCATION_UNCERTAINTY';
        end;
        if v_location_uncertainty_m is null or v_location_uncertainty_m <= 0 then
          raise exception 'INVALID_LOCATION_UNCERTAINTY';
        end if;
        v_location_uncertainty_m := greatest(v_location_uncertainty_m, v_min_address_uncertainty_m);
      else
        if nullif(trim(coalesce(p_order->>'location_accuracy_m', '')), '') is not null then
          raise exception 'INVALID_LOCATION_ACCURACY';
        end if;
        if nullif(trim(coalesce(p_order->>'location_uncertainty_m', '')), '') is not null then
          raise exception 'INVALID_LOCATION_UNCERTAINTY';
        end if;
      end if;

      if v_location_source = 'map_pin' then
        begin
          v_map_pin_confirmed := coalesce((p_order->>'map_pin_confirmed')::boolean, false);
        exception when others then
          raise exception 'MAP_PIN_CONFIRMATION_REQUIRED';
        end;
        if not v_map_pin_confirmed then raise exception 'MAP_PIN_CONFIRMATION_REQUIRED'; end if;
      end if;

      v_raw_distance := round(public.haversine_distance_km(
        v_settings.store_latitude, v_settings.store_longitude, v_latitude, v_longitude
      ), 2);
      if v_location_source = 'address_consensus' then
        v_distance := round(v_raw_distance + (v_location_uncertainty_m / 1000), 2);
      else
        v_distance := v_raw_distance;
      end if;

      if v_settings.maximum_delivery_distance_km is null then raise exception 'DELIVERY_NOT_CONFIGURED'; end if;
      if v_location_source = 'address_consensus' and v_distance > v_settings.maximum_delivery_distance_km then
        raise exception 'ADDRESS_REQUIRES_CONFIRMATION';
      end if;
      if v_location_source <> 'address_consensus' and v_distance > v_settings.maximum_delivery_distance_km then
        raise exception 'OUTSIDE_DELIVERY_AREA';
      end if;

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
  else
    v_location_source := null;
    v_location_accuracy_m := null;
    v_location_uncertainty_m := null;
    v_postal_code := null;
  end if;

  if v_payment_method in ('credito', 'debito') then
    v_card_fee := round((v_subtotal + v_delivery_fee) * v_settings.card_fee_percent / 100, 2);
  end if;
  v_total := v_subtotal + v_delivery_fee + v_card_fee;

  insert into public.orders (
    customer_name, customer_phone, address, reference, delivery_type,
    customer_latitude, customer_longitude, distance_km,
    location_source, location_accuracy_m, location_uncertainty_m,
    payment_method, needs_change, change_for, notes,
    subtotal, delivery_fee, card_fee, total
  ) values (
    trim(p_order->>'customer_name'), trim(p_order->>'customer_phone'),
    nullif(trim(p_order->>'address'), ''), nullif(trim(p_order->>'reference'), ''), v_delivery_type,
    v_latitude, v_longitude, v_distance,
    v_location_source, v_location_accuracy_m, v_location_uncertainty_m,
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
    'raw_distance_km', v_raw_distance,
    'distance_km', v_distance,
    'location_source', v_location_source,
    'location_accuracy_m', v_location_accuracy_m,
    'location_uncertainty_m', v_location_uncertainty_m,
    'postal_code', v_postal_code,
    'subtotal', v_subtotal,
    'delivery_fee', v_delivery_fee,
    'card_fee', v_card_fee,
    'total', v_total
  );
end;
$$;

revoke all on function public.place_order_v2(jsonb) from public;
grant execute on function public.place_order_v2(jsonb) to anon, authenticated;

commit;
