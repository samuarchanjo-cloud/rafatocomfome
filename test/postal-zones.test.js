import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluateOrderDelivery } from "../src/lib/delivery.js";
import { isTrustedDeliveryLocation } from "../src/lib/location.js";
import { createPostalZoneLocation } from "../src/lib/postalZone.js";

const firstMigrationUrl = new URL("../supabase/migrations/20260824_postal_delivery_zones.sql", import.meta.url);
const rulesMigrationUrl = new URL("../supabase/migrations/20260825_delivery_area_rules.sql", import.meta.url);
const fixMigrationUrl = new URL("../supabase/migrations/20260826_fix_exact_exceptions_and_nominatim_street.sql", import.meta.url);
const appUrl = new URL("../src/App.jsx", import.meta.url);
const apiUrl = new URL("../src/lib/api.js", import.meta.url);
const adminUrl = new URL("../src/components/AdminPanel.jsx", import.meta.url);
const stylesUrl = new URL("../src/styles.css", import.meta.url);
const legacyMigrationUrl = new URL("../supabase/migrations/20260720_admin_delivery_security.sql", import.meta.url);

async function sources() {
  const [firstMigration, rulesMigration, fixMigration, app, api, admin, styles, legacy] = await Promise.all([
    readFile(firstMigrationUrl, "utf8"), readFile(rulesMigrationUrl, "utf8"), readFile(fixMigrationUrl, "utf8"), readFile(appUrl, "utf8"),
    readFile(apiUrl, "utf8"), readFile(adminUrl, "utf8"), readFile(stylesUrl, "utf8"), readFile(legacyMigrationUrl, "utf8"),
  ]);
  return { firstMigration, rulesMigration, fixMigration, app, api, admin, styles, legacy };
}

function resolvedRule({ id = "rule-1", deliveryFee = 3, matchType = "exact" } = {}) {
  return { id, deliveryFee, matchType };
}

test("postal_zone usa a regra resolvida sem coordenada ou distância fictícia", () => {
  const location = createPostalZoneLocation(resolvedRule(), "23036-061");
  const assessment = evaluateOrderDelivery("entrega", location, [], {});
  assert.equal(location.latitude, undefined);
  assert.equal(location.longitude, undefined);
  assert.equal(location.km, null);
  assert.equal(location.postalCode, "23036061");
  assert.equal(isTrustedDeliveryLocation(location), true);
  assert.deepEqual(assessment, { allowed: true, fee: 3, code: "POSTAL_ZONE", message: "Entrega disponível para o endereço informado." });
});

test("CEPs 23036-061 e 23036-076 cadastrados como exact usam postal_zone", () => {
  for (const postalCode of ["23036-061", "23036-076"]) {
    const location = createPostalZoneLocation(resolvedRule({ id: `exact-${postalCode}`, matchType: "exact" }), postalCode);
    assert.equal(location.source, "postal_zone");
    assert.equal(location.matchType, "exact");
    assert.equal(location.km, null);
  }
});

test("resultado administrativo inválido não vira localização confiável", () => {
  assert.equal(createPostalZoneLocation(null, "23036-061"), null);
  assert.equal(createPostalZoneLocation(resolvedRule({ id: "" }), "23036-061"), null);
  assert.equal(createPostalZoneLocation(resolvedRule({ matchType: "unknown" }), "23036-061"), null);
  assert.equal(createPostalZoneLocation(resolvedRule({ deliveryFee: -1 }), "23036-061"), null);
  assert.equal(createPostalZoneLocation(resolvedRule({ matchType: "neighborhood" }), "23036-061"), null);
});

test("migration incremental converte registros atuais em exact sem apagar dados", async () => {
  const { rulesMigration } = await sources();
  assert.match(rulesMigration, /add column if not exists match_type text/i);
  assert.match(rulesMigration, /update public\.delivery_postal_zones[\s\S]*set match_type = 'exact'[\s\S]*where match_type is null/i);
  assert.match(rulesMigration, /alter column postal_code drop not null/i);
  assert.doesNotMatch(rulesMigration, /(?:truncate|delete from) public\.delivery_postal_zones/i);
  assert.doesNotMatch(rulesMigration, /(?:drop|truncate|delete from) public\.orders/i);
});

test("migration 20260826 aplica somente o delta necessário sobre o banco já migrado", async () => {
  const { rulesMigration, fixMigration } = await sources();
  assert.match(rulesMigration, /zone\.match_type = 'prefix'/i);
  assert.match(rulesMigration, /zone\.match_type = 'range'/i);
  assert.match(fixMigration, /create or replace function public\.resolve_delivery_area/i);
  assert.match(fixMigration, /create or replace function public\.place_order_v2\(p_order jsonb\)/i);
  assert.doesNotMatch(fixMigration, /create table|drop table|truncate|delete from/i);
  assert.doesNotMatch(fixMigration, /function public\.place_order\s*\(/i);
});

test("migration 20260826 libera nominatim_street com coordenadas, Haversine e faixas do servidor", async () => {
  const { fixMigration } = await sources();
  assert.match(fixMigration, /orders_location_source_allowed[\s\S]*'nominatim_street'/i);
  assert.match(fixMigration, /v_location_source not in \('nominatim_exact', 'nominatim_street'/i);
  assert.match(fixMigration, /v_latitude not between -90 and 90[\s\S]*v_longitude not between -180 and 180/i);
  assert.match(fixMigration, /public\.haversine_distance_km\([\s\S]*v_settings\.store_latitude[\s\S]*v_latitude/i);
  assert.match(fixMigration, /maximum_delivery_distance_km/i);
  assert.match(fixMigration, /from public\.delivery_fee_ranges[\s\S]*v_distance between min_distance_km and max_distance_km/i);

  assert.match(fixMigration, /v_location_source = 'device_gps'[\s\S]*elsif v_location_source = 'address_consensus'[\s\S]*else[\s\S]*INVALID_LOCATION_ACCURACY[\s\S]*INVALID_LOCATION_UNCERTAINTY/i);
  assert.doesNotMatch(fixMigration, /v_location_source = 'nominatim_street' then/i);
});

test("schema suporta exact, prefix, range e neighborhood com campos exclusivos", async () => {
  const { rulesMigration } = await sources();
  for (const column of ["postal_prefix", "postal_code_start", "postal_code_end", "neighborhood", "priority"]) {
    assert.match(rulesMigration, new RegExp(`add column if not exists ${column}`, "i"));
  }
  assert.match(rulesMigration, /match_type in \('exact', 'prefix', 'range', 'neighborhood'\)/i);
  assert.match(rulesMigration, /delivery_postal_zones_rule_shape/i);
  assert.match(rulesMigration, /postal_prefix ~ '\^\[0-9\]\{1,8\}\$'/i);
  assert.match(rulesMigration, /postal_code_start <= postal_code_end/i);
});

test("resolver público preserva a assinatura, mas o checkout envia somente CEP", async () => {
  const { rulesMigration, api } = await sources();
  assert.match(rulesMigration, /function public\.resolve_delivery_area\([\s\S]*p_postal_code text,[\s\S]*p_neighborhood text/i);
  assert.match(rulesMigration, /returns table \(id uuid, delivery_fee numeric, match_type text\)/i);
  assert.match(rulesMigration, /grant execute on function public\.resolve_delivery_area\(text, text\) to anon, authenticated/i);
  assert.match(api, /supabase\.rpc\("resolve_delivery_area", \{[\s\S]*p_postal_code: postalCode,[\s\S]*p_neighborhood: null/i);
  const lookup = api.slice(api.indexOf("resolveDeliveryArea"), api.indexOf("loadDeliveryPostalZones"));
  assert.doesNotMatch(lookup, /\.from\("delivery_postal_zones"\)/);
});

test("RPC público anterior continua compatível com regras baseadas em CEP", async () => {
  const { rulesMigration } = await sources();
  assert.match(rulesMigration, /create or replace function public\.get_delivery_postal_zone\(p_postal_code text\)/i);
  assert.match(rulesMigration, /from public\.resolve_delivery_area\(p_postal_code, null\) area/i);
  assert.match(rulesMigration, /grant execute on function public\.get_delivery_postal_zone\(text\) to anon, authenticated/i);
});

test("resolver financeiro aceita somente exact, ignorando prefix, range e neighborhood", async () => {
  const { fixMigration } = await sources();
  const resolver = fixMigration.slice(fixMigration.indexOf("create or replace function public.resolve_delivery_area"), fixMigration.indexOf("alter table public.orders"));
  assert.match(resolver, /zone\.match_type = 'exact'[\s\S]*zone\.postal_code = request\.postal_code/i);
  assert.doesNotMatch(resolver, /zone\.match_type = '(?:prefix|range|neighborhood)'/i);
});

test("prefix permanece disponível somente como estrutura futura", async () => {
  const { rulesMigration } = await sources();
  assert.match(rulesMigration, /match_type = 'prefix'[\s\S]*postal_prefix ~ '\^\[0-9\]\{1,8\}\$'/i);
});

test("range permanece disponível somente como estrutura futura", async () => {
  const { rulesMigration } = await sources();
  assert.match(rulesMigration, /match_type = 'range'[\s\S]*postal_code_start <= postal_code_end/i);
});

test("neighborhood permanece no schema e Admin, mas é ignorado pela resolução financeira", async () => {
  const { rulesMigration, fixMigration } = await sources();
  assert.match(rulesMigration, /normalize_delivery_neighborhood/i);
  const resolver = fixMigration.slice(fixMigration.indexOf("create or replace function public.resolve_delivery_area"), fixMigration.indexOf("alter table public.orders"));
  assert.doesNotMatch(resolver, /zone\.match_type = 'neighborhood'|request\.neighborhood|normalize_delivery_neighborhood\(zone\.neighborhood\)/i);
  assert.match(resolver, /não participam da decisão financeira/i);
});

test("CEP fora das regras com neighborhood adulterado como Guaratiba continua sem entrega", async () => {
  const { fixMigration, api, app } = await sources();
  const resolver = fixMigration.slice(fixMigration.indexOf("create or replace function public.resolve_delivery_area"), fixMigration.indexOf("alter table public.orders"));
  const postalBranch = fixMigration.slice(fixMigration.indexOf("if v_location_source = 'postal_zone' then"), fixMigration.indexOf("else", fixMigration.indexOf("if v_location_source = 'postal_zone' then")));
  assert.doesNotMatch(resolver, /p_neighborhood[^\n]*=|request\.neighborhood|zone\.neighborhood/i);
  assert.doesNotMatch(postalBranch, /p_order->>'neighborhood'|v_neighborhood/i);
  assert.match(api, /p_neighborhood: null/);
  assert.doesNotMatch(app, /resolveDeliveryArea\(checkout\.postalCode, checkout\.neighborhood/);
});

test("exceção exact inativa é ignorada e priority desempata duplicatas", async () => {
  const { fixMigration } = await sources();
  assert.match(fixMigration, /where zone\.active/i);
  assert.match(fixMigration, /zone\.priority desc/i);
  assert.match(fixMigration, /zone\.created_at asc,[\s\S]*zone\.id asc/i);
});

test("place_order_v2 repete a resolução e rejeita endereço sem regra", async () => {
  const { fixMigration } = await sources();
  const postalBranch = fixMigration.slice(fixMigration.indexOf("if v_location_source = 'postal_zone' then"), fixMigration.indexOf("else", fixMigration.indexOf("if v_location_source = 'postal_zone' then")));
  assert.match(postalBranch, /p_order->>'postal_code'/i);
  assert.doesNotMatch(postalBranch, /p_order->>'neighborhood'/i);
  assert.match(postalBranch, /resolve_delivery_area\(v_postal_code, null\)/i);
  assert.match(postalBranch, /if not found then raise exception 'DELIVERY_ZONE_NOT_FOUND'/i);
});

test("taxa financeira vem do banco e dados inventados pelo frontend são ignorados", async () => {
  const { fixMigration } = await sources();
  assert.match(fixMigration, /v_delivery_fee := v_delivery_area\.delivery_fee/i);
  assert.match(fixMigration, /v_latitude := null;[\s\S]*v_longitude := null;[\s\S]*v_distance := null;/i);
  assert.doesNotMatch(fixMigration, /p_order->>'(?:delivery_fee|total|zone_id|priority|match_type)'/i);
  assert.match(fixMigration, /v_card_fee := round\(\(v_subtotal \+ v_delivery_fee\) \* v_settings\.card_fee_percent \/ 100, 2\)/i);
  assert.match(fixMigration, /v_total := v_subtotal \+ v_delivery_fee \+ v_card_fee/i);
});

test("place_order legado e compatibilidade histórica permanecem intactos", async () => {
  const { fixMigration, legacy } = await sources();
  assert.match(legacy, /create or replace function public\.place_order\(p_order jsonb\)/i);
  assert.doesNotMatch(fixMigration, /function public\.place_order\s*\(/i);
  assert.match(fixMigration, /'nominatim_exact', 'nominatim_street', 'google_exact', 'device_gps', 'map_pin', 'address_consensus', 'postal_zone'/i);
  assert.match(fixMigration, /public\.haversine_distance_km/i);
  assert.match(fixMigration, /maximum_delivery_distance_km/i);
});

test("alterar endereço invalida regra e taxa anteriores", async () => {
  const { app } = await sources();
  const setter = app.slice(app.indexOf("function setCheckoutField"), app.indexOf("function resolveDeliveryCoordinates"));
  assert.match(setter, /DELIVERY_ADDRESS_FIELDS\.has\(field\)/);
  assert.match(setter, /setDeliveryLocation\(null\)/);
  assert.match(setter, /setAddressValidationStatus\(\{ type: "idle", message: "" \}\)/);
});

test("checkout manual sem exceção exact continua no geocoder e GPS permanece em fluxo separado", async () => {
  const { app } = await sources();
  const validation = app.slice(app.indexOf("async function validateDeliveryAddress"), app.indexOf("function changeDeliveryLocation"));
  assert.match(validation, /error\.code === "ADDRESS_NOT_PRECISE"/);
  assert.match(validation, /resolveDeliveryArea\(checkout\.postalCode, \{ signal:/);
  assert.ok(validation.indexOf("resolveDeliveryArea") < validation.indexOf("locateDeliveryAddress"));
  assert.match(validation, /type: "unavailable"/);
  assert.match(app, /Este endereço ainda não está disponível para entrega\./);
  assert.doesNotMatch(app, /MapLocationPicker|Você está no endereço de entrega agora|Sim, usar minha localização/);
  assert.match(app, /requestDeviceGps\(\{ confirmed: true \}\)/);
  assert.match(app, /locationFlow === "address"/);
});

test("checkout e WhatsApp ocultam a regra e suportam distância nula", async () => {
  const { app } = await sources();
  const statusCard = app.slice(app.indexOf("function LocationStatusCard"), app.indexOf("function PixPaymentCard"));
  assert.doesNotMatch(statusCard, /postal_zone|prefixo|bairro|regra|Nominatim|coordenad/i);
  assert.match(statusCard, /Taxa de entrega/);
  assert.match(statusCard, /Number\.isFinite\(Number\(location\.km\)\)/);
  assert.match(app, /order\.distance_km != null/);
  assert.match(app, /composeDeliveryAddress\(checkout\)/);
});

test("Admin gerencia os quatro tipos de área em layout mobile-first", async () => {
  const { admin, styles, api } = await sources();
  assert.match(admin, /Áreas de entrega/);
  assert.match(admin, /Adicionar área/);
  assert.match(admin, /Exceção de geolocalização/);
  assert.match(admin, /Use apenas para CEPs cuja localização automática esteja incorreta\./);
  for (const label of ["CEP exato", "Prefixo de CEP", "Faixa de CEP", "Bairro"]) assert.match(admin, new RegExp(label));
  for (const field of ["postal_code", "postal_prefix", "postal_code_start", "postal_code_end", "neighborhood", "priority"]) assert.match(api, new RegExp(`${field}:`, "i"));
  for (const action of ["Editar", "Ativar", "Desativar", "Excluir"]) assert.match(admin, new RegExp(action));
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*\.postal-zone-row[\s\S]*flex-direction: column/i);
});

test("retirada, Pix, crédito e débito permanecem compatíveis", async () => {
  const { app, fixMigration } = await sources();
  assert.deepEqual(evaluateOrderDelivery("retirada", null, [], {}), { allowed: true, fee: 0, code: "PICKUP", message: "Retirada no local." });
  assert.match(app, /showQrCode && <div className="pix-qr-frame">/);
  assert.match(app, /Copiar chave Pix/);
  assert.match(app, /checkout\.payment === "credito"/);
  assert.match(app, /checkout\.payment === "debito"/);
  assert.match(fixMigration, /v_payment_method in \('credito', 'debito'\)/);
});

test("migration anterior permanece incremental e sem CEPs hardcoded", async () => {
  const { firstMigration, rulesMigration, fixMigration } = await sources();
  assert.match(firstMigration, /create table if not exists public\.delivery_postal_zones/i);
  for (const postalCode of ["23036-061", "23036-076", "23036-060", "23036-050", "23036061", "23036076", "23036060", "23036050"]) {
    assert.doesNotMatch(rulesMigration, new RegExp(postalCode));
    assert.doesNotMatch(fixMigration, new RegExp(postalCode));
  }
});
