import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluateOrderDelivery } from "../src/lib/delivery.js";
import { DELIVERY_ROUTING_FUNCTION, placeRoutedOrder, quoteDeliveryRoute } from "../src/lib/routing.js";
import {
  calculateRouteWithFallback,
  evaluateRouteQuote,
  haversineDistanceKm,
  requestOpenRouteService,
} from "../supabase/functions/_shared/routing.js";

const STORE = { latitude: -22.9438007, longitude: -43.5824387 };
const CUSTOMER = { latitude: -22.928, longitude: -43.5824387 };
const SETTINGS = {
  maximum_delivery_distance_km: 3.5,
  below_one_km_behavior: "fixed",
  below_one_km_fee: 7.25,
};
const RANGES = [{ min_distance_km: 1, max_distance_km: 3.5, fee: 12.75, active: true }];

const edgeFunctionUrl = new URL("../supabase/functions/delivery-routing/index.ts", import.meta.url);
const migrationUrl = new URL("../supabase/migrations/20260827_route_distance_and_uber_delivery.sql", import.meta.url);
const feeFixMigrationUrl = new URL("../supabase/migrations/20260828_fix_operational_delivery_fees.sql", import.meta.url);
const appUrl = new URL("../src/App.jsx", import.meta.url);
const adminUrl = new URL("../src/components/AdminPanel.jsx", import.meta.url);
const apiUrl = new URL("../src/lib/api.js", import.meta.url);

function orsResponse(distanceMeters, durationSeconds = 480) {
  return {
    ok: true,
    json: async () => ({ routes: [{ summary: { distance: distanceMeters, duration: durationSeconds } }] }),
  };
}

test("OpenRouteService recebe longitude antes da latitude e converte distância/duração", async () => {
  let request;
  const route = await requestOpenRouteService(STORE, CUSTOMER, {
    apiKey: "server-secret",
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return orsResponse(2_345, 510);
    },
  });

  assert.match(request.url, /directions\/driving-car$/);
  assert.deepEqual(request.body.coordinates, [
    [STORE.longitude, STORE.latitude],
    [CUSTOMER.longitude, CUSTOMER.latitude],
  ]);
  assert.equal(request.options.headers.Authorization, "server-secret");
  assert.deepEqual(route, { distanceKm: 2.35, durationMinutes: 8.5, source: "openrouteservice" });
});

test("falha do OpenRouteService usa Haversine somente como fallback técnico", async () => {
  let fallbackCode = "";
  const route = await calculateRouteWithFallback(STORE, CUSTOMER, {
    apiKey: "server-secret",
    fetchImpl: async () => { throw new Error("provider unavailable"); },
    onFallback: (error) => { fallbackCode = error.message; },
  });

  assert.equal(route.source, "haversine_fallback");
  assert.equal(route.durationMinutes, null);
  assert.equal(route.distanceKm, Math.round(haversineDistanceKm(STORE, CUSTOMER) * 100) / 100);
  assert.equal(fallbackCode, "provider unavailable");
});

test("faixas usam configuração do Admin e não constantes de taxa", () => {
  for (const distance of [0.8, 0.99, 1]) {
    assert.deepEqual(evaluateRouteQuote(distance, RANGES, SETTINGS), {
      allowed: true, uberAvailable: false, deliveryFee: 7.25, code: "FIXED",
    });
  }
  for (const distance of [1.01, 1.1, 2, 3.5]) {
    assert.deepEqual(evaluateRouteQuote(distance, RANGES, SETTINGS), {
      allowed: true, uberAvailable: false, deliveryFee: 12.75, code: "RANGE",
    });
  }
  assert.deepEqual(evaluateRouteQuote(3.51, RANGES, SETTINGS), {
    allowed: false, uberAvailable: true, deliveryFee: 0, code: "UBER_AVAILABLE",
  });
});

test("regressão comercial usa R$ 3 somente até 1 km e R$ 5 na faixa normal", () => {
  const settings = {
    maximum_delivery_distance_km: 3.5,
    below_one_km_behavior: "fixed",
    below_one_km_fee: 3,
  };
  const ranges = [{ min_distance_km: 1, max_distance_km: 3.5, fee: 5, active: true }];
  for (const [distance, fee] of [[1, 3], [1.01, 5], [1.96, 5], [3.18, 5], [3.5, 5]]) {
    assert.equal(evaluateRouteQuote(distance, ranges, settings).deliveryFee, fee, String(distance));
  }
  assert.deepEqual(evaluateRouteQuote(3.51, ranges, settings), {
    allowed: false, uberAvailable: true, deliveryFee: 0, code: "UBER_AVAILABLE",
  });
});

test("migration incremental corrige a taxa antiga preservada sem editar 20260827", async () => {
  const [previousMigration, feeFixMigration] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(feeFixMigrationUrl, "utf8"),
  ]);
  assert.match(previousMigration, /sem substituir a taxa já cadastrada pelo Admin/i);
  assert.match(feeFixMigration, /below_one_km_behavior = 'fixed'/i);
  assert.match(feeFixMigration, /below_one_km_fee = 3\.00/i);
  assert.match(feeFixMigration, /maximum_delivery_distance_km = 3\.50/i);
  assert.match(feeFixMigration, /set active = false[\s\S]*id <> v_operational_range_id/i);
  assert.match(feeFixMigration, /min_distance_km = 1\.00,[\s\S]*max_distance_km = 3\.50,[\s\S]*fee = 5\.00,[\s\S]*active = true/i);
  assert.doesNotMatch(feeFixMigration, /(?:delete from|truncate|drop table)/i);
});

test("nominatim_exact em 0,8 km e nominatim_street em 2 km usam a distância de rota", () => {
  const exact = evaluateOrderDelivery("entrega", {
    source: "nominatim_exact", precision: "exact", km: 0.8, routeSource: "openrouteservice",
  }, RANGES, SETTINGS);
  const street = evaluateOrderDelivery("entrega", {
    source: "nominatim_street", precision: "street", km: 2, routeSource: "openrouteservice",
  }, RANGES, SETTINGS);

  assert.equal(exact.allowed, true);
  assert.equal(exact.fee, 7.25);
  assert.equal(street.allowed, true);
  assert.equal(street.fee, 12.75);
});

test("Haversine de 1,8 km não prevalece sobre rota de 4,1 km", async () => {
  const destination = { latitude: STORE.latitude + (1.8 / 111.195), longitude: STORE.longitude };
  const straightLine = haversineDistanceKm(STORE, destination);
  const route = await requestOpenRouteService(STORE, destination, {
    apiKey: "server-secret",
    fetchImpl: async () => orsResponse(4_100),
  });
  const quote = evaluateRouteQuote(route.distanceKm, RANGES, SETTINGS);

  assert.ok(straightLine > 1.79 && straightLine < 1.81);
  assert.equal(route.distanceKm, 4.1);
  assert.equal(quote.allowed, false);
  assert.equal(quote.uberAvailable, true);
});

test("cliente usa somente a Edge Function para cotar e salvar pedido", async () => {
  const calls = [];
  const client = {
    functions: {
      async invoke(name, options) {
        calls.push({ name, body: options.body });
        return { data: options.body.action === "quote" ? { distanceKm: 2 } : { id: "order-route" }, error: null };
      },
    },
  };

  await quoteDeliveryRoute({ ...CUSTOMER, source: "nominatim_street" }, client);
  const result = await placeRoutedOrder({ delivery_type: "retirada", delivery_fee: 0.01, total: 0.01 }, client);
  assert.equal(DELIVERY_ROUTING_FUNCTION, "delivery-routing");
  assert.deepEqual(calls.map((call) => call.name), ["delivery-routing", "delivery-routing"]);
  assert.equal(calls[0].body.action, "quote");
  assert.equal(calls[1].body.action, "place_order");
  assert.deepEqual(result, { id: "order-route" });
});

test("postal_zone e retirada não chamam roteamento; RPC privado recalcula valores financeiros", async () => {
  const [edge, migration, api] = await Promise.all([
    readFile(edgeFunctionUrl, "utf8"),
    readFile(migrationUrl, "utf8"),
    readFile(apiUrl, "utf8"),
  ]);
  const placeBranch = edge.slice(edge.indexOf('if (body?.action === "place_order")'));

  assert.match(placeBranch, /delivery_type === "entrega" && order\.geocoding_source !== "postal_zone"[\s\S]*calculateServerRoute/);
  assert.match(placeBranch, /admin\.rpc\("place_order_v4"/);
  assert.match(migration, /if v_location_source = 'postal_zone' then[\s\S]*v_distance := null;[\s\S]*v_delivery_fee := v_delivery_area\.delivery_fee/i);
  assert.match(migration, /v_delivery_type = 'entrega'/i);
  assert.match(migration, /v_delivery_type = 'retirada'|else[\s\S]*v_delivery_mode := null/i);
  assert.match(migration, /v_distance := round\(\(p_route->>'distance_km'\)::numeric, 2\)/i);
  assert.doesNotMatch(migration, /p_order->>'(?:distance_km|delivery_fee|card_fee|subtotal|total)'/i);
  assert.match(migration, /v_card_fee := round\(\(v_subtotal \+ v_delivery_fee\) \* v_settings\.card_fee_percent \/ 100, 2\)/i);
  assert.match(migration, /v_total := v_subtotal \+ v_delivery_fee \+ v_card_fee/i);
  assert.match(migration, /min_distance_km = 1\.00,[\s\S]*max_distance_km = settings\.maximum_delivery_distance_km/i);
  assert.match(migration, /revoke all on function public\.place_order_v3\(jsonb, jsonb\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.place_order_v3\(jsonb, jsonb\) to service_role/i);
  assert.doesNotMatch(api, /place_order_v3/);
});

test("checkout mostra rota e Uber sem alterar Pix, retirada ou fontes de endereço", async () => {
  const [app, admin] = await Promise.all([readFile(appUrl, "utf8"), readFile(adminUrl, "utf8")]);
  assert.match(app, /Distância da rota/);
  assert.match(app, /Quero retirar por Uber/);
  assert.match(app, /Uber pago separadamente pelo cliente/);
  assert.match(app, /delivery_mode:/);
  assert.match(app, /checkout\.payment === "pix"/);
  assert.match(app, /deliveryType === "retirada"/);
  assert.match(admin, /Taxa até 1 km \(R\$\)/);
  assert.match(admin, /Taxa acima de 1 km \(R\$\)/);
  assert.match(admin, /Limite da entrega própria \(km\)/);
  assert.doesNotMatch(admin, /(?:R\$\s*)?(?:3[,.]00|5[,.]00|3[,.]50)/);
  assert.doesNotMatch(app, /VITE_OPENROUTESERVICE_API_KEY/);
});

test("avaliação local mantém fronteiras operacionais de 1,00 e 3,50 km", () => {
  for (const [distance, fee] of [[0.99, 7.25], [1, 7.25], [1.01, 12.75], [1.1, 12.75], [3.5, 12.75]]) {
    const result = evaluateOrderDelivery("entrega", {
      source: "nominatim_exact", precision: "exact", km: distance,
    }, RANGES, SETTINGS);
    assert.equal(result.allowed, true, String(distance));
    assert.equal(result.fee, fee, String(distance));
  }
  const outside = evaluateOrderDelivery("entrega", {
    source: "nominatim_exact", precision: "exact", km: 3.51,
  }, RANGES, SETTINGS);
  assert.equal(outside.allowed, false);
  assert.equal(outside.uberAvailable, true);
});
