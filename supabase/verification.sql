-- CONSULTAS SOMENTE DE LEITURA.
-- Execute o bloco "ANTES" e salve o resultado. Depois da migração, execute "DEPOIS".

-- ============================================================
-- ANTES DA MIGRAÇÃO
-- ============================================================

-- Deve retornar 37 linhas totais e 37 visíveis, conforme o estado informado.
select
  count(*) as total_products,
  count(*) filter (where coalesce(visible, true)) as visible_products,
  count(*) filter (where not coalesce(visible, true)) as hidden_products
from public.products;

-- Guarde este checksum. A migração usa a mesma expressão e aborta se ele mudar.
select md5(coalesce(string_agg(
  jsonb_build_array(id, name, description, price, category, image_url, status, visible)::text,
  '|' order by id
), '')) as protected_products_checksum
from public.products;

-- Distribuição real dos valores textuais existentes em category e status.
select category, count(*) as products from public.products group by category order by category;
select status, count(*) as products from public.products group by status order by status;

-- Devem retornar zero linhas.
select id, count(*) from public.products group by id having count(*) > 1;
select id from public.products
where id is null or name is null or price is null or category is null or image_url is null or status is null;

-- Colunas, constraints, índices, políticas e privilégios atuais para auditoria.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'products'
order by ordinal_position;

select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.products'::regclass
order by conname;

select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'products'
order by indexname;

select policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'products'
order by cmd, policyname;

select
  has_table_privilege('anon', 'public.products', 'SELECT') as anon_can_select,
  has_table_privilege('anon', 'public.products', 'INSERT') as anon_can_insert,
  has_table_privilege('anon', 'public.products', 'UPDATE') as anon_can_update,
  has_table_privilege('anon', 'public.products', 'DELETE') as anon_can_delete;

-- ============================================================
-- DEPOIS DA MIGRAÇÃO
-- ============================================================

-- Compare contagem e checksum com o resultado anterior: devem ser idênticos.
select
  count(*) as total_products,
  count(*) filter (where coalesce(visible, true)) as visible_products,
  count(*) filter (where not coalesce(visible, true)) as hidden_products,
  md5(coalesce(string_agg(
    jsonb_build_array(id, name, description, price, category, image_url, status, visible)::text,
    '|' order by id
  ), '')) as protected_products_checksum
from public.products;

-- As únicas colunas adicionadas pela migração, caso ainda não existissem.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'products'
  and column_name in ('featured', 'sort_order')
order by column_name;

-- Todas devem existir uma única vez.
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'products', 'categories', 'business_hours', 'delivery_fee_ranges',
    'app_settings', 'app_admins', 'orders', 'order_items'
  )
order by table_name;

-- category continua texto e sem FK para categories.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'products' and column_name = 'category';

select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.products'::regclass
  and contype = 'f'
  and pg_get_constraintdef(oid) ilike '%category%';

-- Deve retornar 7 dias e quarta a domingo abertos entre 19:00 e 23:00.
select * from public.business_hours order by day_of_week;

-- Inicialmente: zero faixas, comportamento blocked e distância máxima NULL.
select count(*) as delivery_ranges from public.delivery_fee_ranges;
select below_one_km_behavior, below_one_km_fee, maximum_delivery_distance_km, timezone
from public.app_settings where id = 'global';

-- Leitura pública deve permanecer; escrita anon deve estar revogada.
select
  has_table_privilege('anon', 'public.products', 'SELECT') as anon_can_select,
  has_table_privilege('anon', 'public.products', 'INSERT') as anon_can_insert,
  has_table_privilege('anon', 'public.products', 'UPDATE') as anon_can_update,
  has_table_privilege('anon', 'public.products', 'DELETE') as anon_can_delete,
  has_table_privilege('authenticated', 'public.products', 'UPDATE') as authenticated_has_update_grant;

select policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in (
    'products', 'categories', 'business_hours', 'delivery_fee_ranges',
    'app_settings', 'app_admins', 'orders', 'order_items'
  )
order by tablename, cmd, policyname;

-- Depois de cadastrar a administradora, deve retornar uma linha com seu UUID.
select user_id, created_at from public.app_admins order by created_at;

-- Verificação pública real recomendada fora do SQL Editor:
-- abra o cardápio em uma janela anônima e confirme que os 37 produtos continuam carregando.
