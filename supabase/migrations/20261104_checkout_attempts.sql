-- Additive: legacy place_order_v4 callers remain compatible.
create schema if not exists checkout_private;
revoke all on schema checkout_private from public, anon, authenticated;

create table checkout_private.attempts (
  id uuid primary key,
  secret_hash bytea not null,
  payload_hash bytea not null,
  actor_id uuid,
  order_id uuid references public.orders(id) on delete set null,
  expires_at timestamptz not null default (now() + interval '24 hours')
);
alter table checkout_private.attempts enable row level security;
revoke all on checkout_private.attempts from public, anon, authenticated;

create function public.checkout_attempt_receipt(
  p_id uuid, p_secret text, p_actor uuid, p_order jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  attempt checkout_private.attempts%rowtype;
  receipt jsonb;
begin
  select * into attempt from checkout_private.attempts where id = p_id;
  if not found then return null; end if;

  if attempt.actor_id is distinct from p_actor
     or attempt.secret_hash is distinct from pg_catalog.sha256(pg_catalog.convert_to(p_secret, 'UTF8'))
     or (p_actor is null and attempt.expires_at <= now())
     or attempt.order_id is null
     or (p_order is not null and attempt.payload_hash is distinct from pg_catalog.sha256(pg_catalog.convert_to(p_order::text, 'UTF8'))) then
    if p_order is null then return null; end if;
    raise exception 'CHECKOUT_ATTEMPT_CONFLICT';
  end if;

  select jsonb_build_object(
    'id', o.id, 'customer_id', o.customer_id, 'customer_address_id', o.customer_address_id,
    'customer_name', o.customer_name, 'customer_phone', o.customer_phone, 'address', o.address,
    'delivery_type', o.delivery_type, 'delivery_mode', o.delivery_mode, 'distance_km', o.distance_km,
    'payment_method', o.payment_method, 'needs_change', o.needs_change, 'change_for', o.change_for,
    'notes', o.notes, 'subtotal', o.subtotal, 'delivery_fee', o.delivery_fee, 'card_fee', o.card_fee,
    'total', o.total, 'items', (select coalesce(jsonb_agg(jsonb_build_object(
      'name', i.product_name, 'quantity', i.quantity, 'product_id', i.product_id,
      'unit_price', i.unit_price, 'line_total', i.line_total
    ) order by i.created_at, i.id), '[]'::jsonb) from public.order_items i where i.order_id = o.id)
  ) into receipt from public.orders o where o.id = attempt.order_id;
  return receipt;
end;
$$;

create function public.place_order_once(
  p_id uuid, p_secret text, p_actor uuid, p_order jsonb, p_route jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  created jsonb;
begin
  if p_id is null or p_secret is null or p_secret !~ '^[a-f0-9]{64}$' or p_order is null then
    raise exception 'INVALID_CHECKOUT_ATTEMPT';
  end if;

  -- The unique index makes concurrent callers wait for the winner's transaction.
  insert into checkout_private.attempts(id, secret_hash, payload_hash, actor_id)
  values (p_id, pg_catalog.sha256(pg_catalog.convert_to(p_secret, 'UTF8')),
    pg_catalog.sha256(pg_catalog.convert_to(p_order::text, 'UTF8')), p_actor)
  on conflict (id) do nothing;

  if found then
    created := public.place_order_v4(p_order, p_route, p_actor);
    update checkout_private.attempts set order_id = (created->>'id')::uuid where id = p_id;
  end if;

  return public.checkout_attempt_receipt(p_id, p_secret, p_actor, p_order);
end;
$$;

revoke all on function public.checkout_attempt_receipt(uuid,text,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.place_order_once(uuid,text,uuid,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.checkout_attempt_receipt(uuid,text,uuid,jsonb) to service_role;
grant execute on function public.place_order_once(uuid,text,uuid,jsonb,jsonb) to service_role;
