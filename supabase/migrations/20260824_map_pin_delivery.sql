begin;

alter table public.orders drop constraint if exists orders_location_source_allowed;
alter table public.orders
  add constraint orders_location_source_allowed
  check (
    location_source is null
    or location_source in ('nominatim_exact', 'google_exact', 'device_gps', 'map_pin', 'address_consensus')
  );

alter table public.orders drop constraint if exists orders_location_accuracy_valid;
alter table public.orders
  add constraint orders_location_accuracy_valid
  check (
    (location_source is null and location_accuracy_m is null)
    or (location_source in ('nominatim_exact', 'google_exact', 'map_pin', 'address_consensus') and location_accuracy_m is null)
    or (
      location_source = 'device_gps'
      and location_accuracy_m > 0
      and location_accuracy_m <= 150
    )
  );

alter table public.orders drop constraint if exists orders_location_uncertainty_valid;
alter table public.orders
  add constraint orders_location_uncertainty_valid
  check (
    (location_source is null and location_uncertainty_m is null)
    or (location_source in ('nominatim_exact', 'google_exact', 'device_gps', 'map_pin') and location_uncertainty_m is null)
    or (location_source = 'address_consensus' and location_uncertainty_m >= 750)
  );

create or replace function public.place_order_v2(p_order jsonb)
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
  v_raw_distance numeric(8,2);
  v_distance numeric(8,2);
  v_order_id uuid;
  v_delivery_type text := p_order->>'delivery_type';
  v_payment_method text := p_order->>'payment_method';
  v_latitude numeric;
  v_longitude numeric;
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
       or v_location_source not in ('nominatim_exact', 'google_exact', 'device_gps', 'map_pin', 'address_consensus') then
      raise exception 'INVALID_LOCATION_SOURCE';
    end if;
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
  else
    v_location_source := null;
    v_location_accuracy_m := null;
    v_location_uncertainty_m := null;
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
