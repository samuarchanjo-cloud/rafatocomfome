import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { callPlaceOrderRpc, PLACE_ORDER_RPC } from "../src/lib/orderRpc.js";

const legacyMigrationUrl = new URL("../supabase/migrations/20260720_admin_delivery_security.sql", import.meta.url);
const trustedLocationMigrationUrl = new URL("../supabase/migrations/20260823_trusted_delivery_location.sql", import.meta.url);
const consensusMigrationUrl = new URL("../supabase/migrations/20260824_address_consensus_delivery.sql", import.meta.url);
const mapPinMigrationUrl = new URL("../supabase/migrations/20260824_map_pin_delivery.sql", import.meta.url);
const routeMigrationUrl = new URL("../supabase/migrations/20260827_route_distance_and_uber_delivery.sql", import.meta.url);

async function migrations() {
  const [legacy, trustedLocation, consensus, mapPin, route] = await Promise.all([
    readFile(legacyMigrationUrl, "utf8"),
    readFile(trustedLocationMigrationUrl, "utf8"),
    readFile(consensusMigrationUrl, "utf8"),
    readFile(mapPinMigrationUrl, "utf8"),
    readFile(routeMigrationUrl, "utf8"),
  ]);
  return { legacy, trustedLocation, consensus, mapPin, route };
}

test("wrapper place_order_v2 permanece disponível para compatibilidade", async () => {
  const calls = [];
  const client = {
    async rpc(name, parameters) {
      calls.push({ name, parameters });
      return { data: { id: "order-v2" }, error: null };
    },
  };
  const payload = { location_source: "nominatim_exact" };

  const result = await callPlaceOrderRpc(client, payload);

  assert.equal(PLACE_ORDER_RPC, "place_order_v2");
  assert.deepEqual(calls, [{ name: "place_order_v2", parameters: { p_order: payload } }]);
  assert.deepEqual(result, { id: "order-v2" });
});

test("migration de rota cria v3 privado sem substituir place_order ou place_order_v2", async () => {
  const { route } = await migrations();

  assert.match(route, /create or replace function public\.place_order_v3\(p_order jsonb, p_route jsonb/i);
  assert.doesNotMatch(route, /create or replace function public\.place_order(?:_v2)?\s*\(/i);
  assert.doesNotMatch(route, /(?:drop|revoke all on) function public\.place_order(?:_v2)?\s*\(/i);
  assert.match(route, /grant execute on function public\.place_order_v3\(jsonb, jsonb\) to service_role/i);
});

test("migration nova preserva o RPC place_order legado", async () => {
  const { legacy, trustedLocation } = await migrations();

  assert.match(legacy, /create or replace function public\.place_order\(p_order jsonb\)/i);
  assert.doesNotMatch(trustedLocation, /function public\.place_order\s*\(/i);
  assert.doesNotMatch(trustedLocation, /(?:drop|revoke all on) function public\.place_order\s*\(/i);
  assert.match(trustedLocation, /create or replace function public\.place_order_v2\(p_order jsonb\)/i);
});

test("place_order_v2 exige fonte confiável e precisão válida para GPS", async () => {
  const { trustedLocation } = await migrations();

  assert.match(trustedLocation, /v_location_source is null or v_location_source not in \('nominatim_exact', 'device_gps'\)/i);
  assert.match(trustedLocation, /raise exception 'INVALID_LOCATION_SOURCE'/i);
  assert.match(trustedLocation, /v_location_source = 'device_gps'/i);
  assert.match(trustedLocation, /v_location_accuracy_m > 150/i);
  assert.match(trustedLocation, /raise exception 'INVALID_LOCATION_ACCURACY'/i);
  assert.match(trustedLocation, /public\.haversine_distance_km/i);
});

test("novas colunas nullable mantêm pedidos antigos compatíveis", async () => {
  const { trustedLocation } = await migrations();

  assert.match(trustedLocation, /add column if not exists location_source text,/i);
  assert.match(trustedLocation, /add column if not exists location_accuracy_m numeric\(8,2\);/i);
  assert.doesNotMatch(trustedLocation, /location_(?:source|accuracy_m)[^,;\n]*not null/i);
  assert.match(trustedLocation, /location_source is null and location_accuracy_m is null/i);
});

test("migration de consenso não altera o RPC legado nem a migration já aplicada", async () => {
  const { trustedLocation, consensus } = await migrations();

  assert.match(trustedLocation, /v_location_source not in \('nominatim_exact', 'device_gps'\)/i);
  assert.doesNotMatch(trustedLocation, /address_consensus/i);
  assert.doesNotMatch(consensus, /function public\.place_order\s*\(/i);
  assert.doesNotMatch(consensus, /(?:drop|revoke all on) function public\.place_order\s*\(/i);
  assert.match(consensus, /create or replace function public\.place_order_v2\(p_order jsonb\)/i);
});

test("place_order_v2 aceita consenso, aplica incerteza mínima e calcula distância efetiva no servidor", async () => {
  const { consensus } = await migrations();

  assert.match(consensus, /location_source in \('nominatim_exact', 'device_gps', 'address_consensus'\)/i);
  assert.match(consensus, /v_location_source not in \('nominatim_exact', 'device_gps', 'address_consensus'\)/i);
  assert.match(consensus, /v_min_address_uncertainty_m constant numeric := 750/i);
  assert.match(consensus, /greatest\(v_location_uncertainty_m, v_min_address_uncertainty_m\)/i);
  assert.match(consensus, /v_raw_distance := round\(public\.haversine_distance_km/i);
  assert.match(consensus, /v_distance := round\(v_raw_distance \+ \(v_location_uncertainty_m \/ 1000\), 2\)/i);
  assert.match(consensus, /location_uncertainty_m/i);
});

test("consenso fora pelo limite conservador pede confirmação; exato e GPS continuam bloqueando", async () => {
  const { consensus } = await migrations();

  assert.match(
    consensus,
    /v_location_source = 'address_consensus' and v_distance > v_settings\.maximum_delivery_distance_km[\s\S]*ADDRESS_REQUIRES_CONFIRMATION/i,
  );
  assert.match(
    consensus,
    /v_location_source <> 'address_consensus' and v_distance > v_settings\.maximum_delivery_distance_km[\s\S]*OUTSIDE_DELIVERY_AREA/i,
  );
});

test("coluna de incerteza é nullable e preserva pedidos antigos", async () => {
  const { consensus } = await migrations();

  assert.match(consensus, /add column if not exists location_uncertainty_m numeric\(10,2\);/i);
  assert.doesNotMatch(consensus, /location_uncertainty_m[^,;\n]*not null/i);
  assert.match(consensus, /location_source is null and location_uncertainty_m is null/i);
  assert.match(consensus, /location_source = 'address_consensus' and location_uncertainty_m >= 750/i);
});

test("migration do PIN preserva migrations executadas e o place_order legado", async () => {
  const { trustedLocation, consensus, mapPin } = await migrations();

  assert.doesNotMatch(trustedLocation, /map_pin|google_exact/i);
  assert.doesNotMatch(consensus, /map_pin|google_exact/i);
  assert.doesNotMatch(mapPin, /function public\.place_order\s*\(/i);
  assert.doesNotMatch(mapPin, /(?:drop|revoke all on) function public\.place_order\s*\(/i);
  assert.match(mapPin, /create or replace function public\.place_order_v2\(p_order jsonb\)/i);
});

test("place_order_v2 aceita map_pin confirmado e google_exact", async () => {
  const { mapPin } = await migrations();

  assert.match(mapPin, /'nominatim_exact', 'google_exact', 'device_gps', 'map_pin', 'address_consensus'/i);
  assert.match(mapPin, /v_location_source = 'map_pin'/i);
  assert.match(mapPin, /p_order->>'map_pin_confirmed'/i);
  assert.match(mapPin, /raise exception 'MAP_PIN_CONFIRMATION_REQUIRED'/i);
  assert.match(mapPin, /public\.haversine_distance_km/i);
});

test("PIN, GPS e endereço exato acima do limite continuam OUTSIDE_DELIVERY_AREA", async () => {
  const { mapPin } = await migrations();

  assert.match(
    mapPin,
    /v_location_source <> 'address_consensus' and v_distance > v_settings\.maximum_delivery_distance_km[\s\S]*OUTSIDE_DELIVERY_AREA/i,
  );
  assert.match(mapPin, /where active and v_distance between min_distance_km and max_distance_km/i);
  assert.match(mapPin, /v_total := v_subtotal \+ v_delivery_fee \+ v_card_fee/i);
});
