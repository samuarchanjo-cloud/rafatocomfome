-- Corrige a faixa operacional que a migration 20260827 preservou com taxa antiga.
-- Não apaga faixas: mantém uma ativa e desativa excedentes para tornar a regra inequívoca.

begin;

update public.app_settings
set
  below_one_km_behavior = 'fixed',
  below_one_km_fee = 3.00,
  maximum_delivery_distance_km = 3.50
where id = 'global';

do $$
declare
  v_operational_range_id uuid;
begin
  select id into v_operational_range_id
  from public.delivery_fee_ranges
  where active
  order by min_distance_km asc, created_at asc, id asc
  limit 1;

  if v_operational_range_id is null then
    insert into public.delivery_fee_ranges (
      min_distance_km, max_distance_km, fee, active
    ) values (
      1.00, 3.50, 5.00, true
    );
  else
    update public.delivery_fee_ranges
    set active = false
    where active and id <> v_operational_range_id;

    update public.delivery_fee_ranges
    set
      min_distance_km = 1.00,
      max_distance_km = 3.50,
      fee = 5.00,
      active = true
    where id = v_operational_range_id;
  end if;
end $$;

commit;
