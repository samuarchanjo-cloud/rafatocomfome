import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluateOrderDelivery } from "../src/lib/delivery.js";
import { isTrustedDeliveryLocation } from "../src/lib/location.js";
import { createPostalZoneLocation } from "../src/lib/postalZone.js";

const migrationUrl = new URL("../supabase/migrations/20260824_postal_delivery_zones.sql", import.meta.url);
const appUrl = new URL("../src/App.jsx", import.meta.url);
const apiUrl = new URL("../src/lib/api.js", import.meta.url);
const adminUrl = new URL("../src/components/AdminPanel.jsx", import.meta.url);
const stylesUrl = new URL("../src/styles.css", import.meta.url);
const legacyMigrationUrl = new URL("../supabase/migrations/20260720_admin_delivery_security.sql", import.meta.url);

async function sources() {
  const [migration, app, api, admin, styles, legacy] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(appUrl, "utf8"),
    readFile(apiUrl, "utf8"),
    readFile(adminUrl, "utf8"),
    readFile(stylesUrl, "utf8"),
    readFile(legacyMigrationUrl, "utf8"),
  ]);
  return { migration, app, api, admin, styles, legacy };
}

test("zona administrativa de R$ 3 é confiável para UI sem coordenada ou distância fictícia", () => {
  const location = createPostalZoneLocation({ postal_code: "23036061", delivery_fee: 3 }, "23036-061");
  const assessment = evaluateOrderDelivery("entrega", location, [], {});
  assert.equal(location.latitude, undefined);
  assert.equal(location.longitude, undefined);
  assert.equal(location.km, null);
  assert.equal(isTrustedDeliveryLocation(location), true);
  assert.deepEqual(assessment, {
    allowed: true,
    fee: 3,
    code: "POSTAL_ZONE",
    message: "Entrega disponível para o endereço informado.",
  });
});

test("zona administrativa de R$ 5 usa a taxa recebida do RPC", () => {
  const location = createPostalZoneLocation({ postalCode: "23036076", deliveryFee: 5 }, "23036-076");
  assert.equal(evaluateOrderDelivery("entrega", location, [], {}).fee, 5);
});

test("zona de outro CEP ou taxa inválida não é aceita pelo frontend", () => {
  assert.equal(createPostalZoneLocation({ postal_code: "23036050", delivery_fee: 3 }, "23036-061"), null);
  assert.equal(createPostalZoneLocation({ postal_code: "23036061", delivery_fee: -1 }, "23036-061"), null);
});

test("migration cria tabela vazia normalizada e não cadastra CEPs de regressão", async () => {
  const { migration } = await sources();
  assert.match(migration, /create table if not exists public\.delivery_postal_zones/i);
  assert.match(migration, /postal_code text not null unique check \(postal_code ~ '\^\[0-9\]\{8\}\$'\)/i);
  assert.match(migration, /delivery_fee numeric\(10,2\) not null check \(delivery_fee >= 0\)/i);
  for (const postalCode of ["23036-061", "23036-076", "23036-060", "23036-050", "23036061", "23036076", "23036060", "23036050"]) {
    assert.doesNotMatch(migration, new RegExp(postalCode));
  }
});

test("RLS impede escrita pública e permite CRUD apenas ao administrador", async () => {
  const { migration } = await sources();
  assert.match(migration, /alter table public\.delivery_postal_zones enable row level security/i);
  assert.match(migration, /revoke all on table public\.delivery_postal_zones from anon/i);
  for (const action of ["select", "insert", "update", "delete"]) {
    assert.match(migration, new RegExp(`create policy delivery_postal_zones_admin_${action}[\\s\\S]*public\\.is_admin\\(\\)`, "i"));
  }
  assert.doesNotMatch(migration, /delivery_postal_zones[^;]*for (?:insert|update|delete) to anon/i);
});

test("checkout público consulta somente RPC de zona ativa", async () => {
  const { migration, api } = await sources();
  assert.match(migration, /create or replace function public\.get_delivery_postal_zone\(p_postal_code text\)/i);
  assert.match(migration, /where zone\.active[\s\S]*zone\.postal_code = regexp_replace/i);
  assert.match(migration, /grant execute on function public\.get_delivery_postal_zone\(text\) to anon, authenticated/i);
  assert.match(api, /supabase\.rpc\("get_delivery_postal_zone", \{ p_postal_code: postalCode \}\)/);
  assert.doesNotMatch(api.slice(api.indexOf("findDeliveryPostalZone"), api.indexOf("loadDeliveryPostalZones")), /\.from\("delivery_postal_zones"\)/);
});

test("place_order_v2 aceita postal_zone e exige zona ativa do CEP completo", async () => {
  const { migration } = await sources();
  assert.match(migration, /v_location_source not in \('nominatim_exact', 'google_exact', 'device_gps', 'map_pin', 'address_consensus', 'postal_zone'\)/i);
  assert.match(migration, /v_postal_code := regexp_replace\(coalesce\(p_order->>'postal_code', ''\), '\[\^0-9\]', '', 'g'\)/i);
  assert.match(migration, /where zone\.postal_code = v_postal_code and zone\.active/i);
  assert.match(migration, /if not found then raise exception 'DELIVERY_ZONE_NOT_FOUND'/i);
});

test("postal_zone usa taxa do banco, ignora valores financeiros do cliente e não aplica Haversine", async () => {
  const { migration } = await sources();
  const postalBranch = migration.slice(
    migration.indexOf("if v_location_source = 'postal_zone' then"),
    migration.indexOf("else", migration.indexOf("if v_location_source = 'postal_zone' then")),
  );
  assert.match(postalBranch, /v_delivery_fee := v_postal_zone\.delivery_fee/i);
  assert.match(postalBranch, /v_distance := null/i);
  assert.match(postalBranch, /v_latitude := null/i);
  assert.doesNotMatch(postalBranch, /haversine_distance_km/i);
  assert.doesNotMatch(migration, /p_order->>'(?:delivery_fee|total|zone_id)'/i);
  assert.match(migration, /v_card_fee := round\(\(v_subtotal \+ v_delivery_fee\) \* v_settings\.card_fee_percent \/ 100, 2\)/i);
  assert.match(migration, /v_total := v_subtotal \+ v_delivery_fee \+ v_card_fee/i);
});

test("tentativa de inventar postal_zone não usa coordenadas nem zone_id do navegador", async () => {
  const { migration } = await sources();
  assert.match(migration, /select zone\.\* into v_postal_zone[\s\S]*from public\.delivery_postal_zones zone[\s\S]*where zone\.postal_code = v_postal_code and zone\.active/i);
  assert.match(migration, /v_latitude := null;[\s\S]*v_longitude := null;/i);
  assert.doesNotMatch(migration, /p_order->>'zone_id'/i);
});

test("migration preserva place_order legado e pedidos históricos", async () => {
  const { migration, legacy } = await sources();
  assert.match(legacy, /create or replace function public\.place_order\(p_order jsonb\)/i);
  assert.doesNotMatch(migration, /function public\.place_order\s*\(/i);
  assert.doesNotMatch(migration, /(?:drop|truncate|delete from) public\.orders/i);
  assert.match(migration, /create or replace function public\.place_order_v2\(p_order jsonb\)/i);
  assert.match(migration, /location_source is null[\s\S]*postal_zone/i);
});

test("alterar endereço invalida zona e taxa anteriores", async () => {
  const { app } = await sources();
  const setter = app.slice(app.indexOf("function setCheckoutField"), app.indexOf("function resolveDeliveryCoordinates"));
  assert.match(setter, /DELIVERY_ADDRESS_FIELDS\.has\(field\)/);
  assert.match(setter, /setDeliveryLocation\(null\)/);
  assert.match(setter, /setAddressValidationStatus\(\{ type: "idle", message: "" \}\)/);
});

test("GPS aparece somente após ADDRESS_NOT_PRECISE sem zona e não exige PIN", async () => {
  const { app } = await sources();
  const validation = app.slice(app.indexOf("async function validateDeliveryAddress"), app.indexOf("async function requestAndAcceptDeviceLocation"));
  assert.match(validation, /error\.code === "ADDRESS_NOT_PRECISE"/);
  assert.match(validation, /findDeliveryPostalZone/);
  assert.match(validation, /if \(location\)[\s\S]*else \{[\s\S]*type: "needs-gps"/);
  assert.doesNotMatch(validation, /openMapPicker/);
  assert.match(app, /Você está no endereço de entrega agora\?/);
  assert.match(app, /Sim, usar minha localização/);
  assert.match(app, /Não, revisar endereço/);
});

test("cliente distante pode pedir para postal_zone sem GPS", () => {
  const location = createPostalZoneLocation({ postal_code: "23036060", delivery_fee: 5 }, "23036-060");
  assert.equal(isTrustedDeliveryLocation(location), true);
  assert.equal("accuracy" in location, false);
  assert.equal(evaluateOrderDelivery("entrega", location, [], {}).allowed, true);
});

test("checkout e WhatsApp ocultam detalhes técnicos e suportam distância nula", async () => {
  const { app } = await sources();
  const statusCard = app.slice(app.indexOf("function LocationStatusCard"), app.indexOf("function PixPaymentCard"));
  assert.doesNotMatch(statusCard, /postal_zone|zona postal|Nominatim|coordenad|consenso|margem/i);
  assert.match(statusCard, /Taxa de entrega/);
  assert.match(statusCard, /Number\.isFinite\(Number\(location\.km\)\)/);
  assert.match(app, /order\.distance_km != null/);
  assert.match(app, /composeDeliveryAddress\(checkout\)/);
});

test("Admin oferece CRUD mobile-first para áreas por CEP", async () => {
  const { admin, styles } = await sources();
  assert.match(admin, /Áreas de entrega por CEP/);
  assert.match(admin, /Adicionar CEP/);
  for (const action of ["Editar", "Ativar", "Desativar", "Excluir"]) assert.match(admin, new RegExp(action));
  assert.match(admin, /Taxa de entrega \(R\$\)/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*\.postal-zone-row[\s\S]*flex-direction: column/i);
});

test("Pix, crédito, débito e layout atual permanecem presentes", async () => {
  const { app, migration } = await sources();
  assert.match(app, /showQrCode && <div className="pix-qr-frame">/);
  assert.match(app, /Copiar chave Pix/);
  assert.match(app, /checkout\.payment === "credito"/);
  assert.match(app, /checkout\.payment === "debito"/);
  assert.match(migration, /v_payment_method in \('credito', 'debito'\)/);
});
