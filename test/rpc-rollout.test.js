import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { callPlaceOrderRpc, PLACE_ORDER_RPC } from "../src/lib/orderRpc.js";

const legacyMigrationUrl = new URL("../supabase/migrations/20260720_admin_delivery_security.sql", import.meta.url);
const trustedLocationMigrationUrl = new URL("../supabase/migrations/20260823_trusted_delivery_location.sql", import.meta.url);

async function migrations() {
  const [legacy, trustedLocation] = await Promise.all([
    readFile(legacyMigrationUrl, "utf8"),
    readFile(trustedLocationMigrationUrl, "utf8"),
  ]);
  return { legacy, trustedLocation };
}

test("API nova chama exclusivamente place_order_v2", async () => {
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
