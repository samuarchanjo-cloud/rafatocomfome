import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { placeRoutedOrder, quoteDeliveryRoute } from '../src/lib/routing.js';
import { evaluateRouteQuote } from '../supabase/functions/_shared/routing.js';

// Real frontend wrapper -> real Edge handler -> mocked Auth/route/database.
// This verifies the wire contract, not the hosted gateway or PostgreSQL runtime.
const source = readFileSync(new URL('../supabase/functions/delivery-routing/index.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');

function integration({ signedIn = false, rejectIdentity = false } = {}) {
  let handler;
  const calls = [];
  const session = signedIn ? { access_token: 'user-token', expires_at: Date.now() / 1000 + 3600, user: { id: 'customer' } } : null;
  const settings = { store_latitude: -48, store_longitude: -119, maximum_delivery_distance_km: 3.5, below_one_km_behavior: 'fixed', below_one_km_fee: 3 };
  const ranges = [{ active: true, min_distance_km: 1, max_distance_km: 3.5, fee: 5 }];
  const admin = {
    from(table) {
      const query = {
        select() { return query; }, eq() { return query; },
        single: async () => ({ data: settings }), order: async () => ({ data: ranges }),
      };
      assert.ok(['app_settings', 'delivery_fee_ranges'].includes(table));
      return query;
    },
    async rpc(name, payload) {
      calls.push({ name, payload });
      return { data: { id: 'order-id', items: [{ name: 'Teste', quantity: 1, unit_price: 10, line_total: 10 }], subtotal: 10, delivery_fee: 5, card_fee: 0, total: 15, customer_id: payload.p_actor_user_id } };
    },
  };
  const env = { SUPABASE_URL: 'https://synthetic.test', SUPABASE_SERVICE_ROLE_KEY: 'service', SUPABASE_ANON_KEY: 'anon' };
  vm.runInNewContext(source, {
    Response, console: { warn() {}, error() {} },
    Deno: { env: { get: key => env[key] }, serve: fn => { handler = fn; } },
    createClient: (_url, key) => key === 'service' ? admin : { auth: { getUser: async () => ({ data: { user: rejectIdentity ? null : { id: 'customer' } }, error: rejectIdentity ? new Error('expired') : null }) } },
    calculateRouteWithFallback: async () => ({ distanceKm: 2, durationMinutes: 5, source: 'openrouteservice' }),
    evaluateRouteQuote,
  });
  const client = {
    auth: { getSession: async () => ({ data: { session } }) },
    functions: { async invoke(name, options) {
      assert.equal(name, 'delivery-routing');
      const response = await handler(new Request('https://synthetic.test', {
        method: 'POST', headers: { Authorization: options.headers?.Authorization || 'Bearer anon' }, body: JSON.stringify(options.body),
      }));
      if (!response.ok) return { error: { context: response, message: 'non-2xx' } };
      return { data: await response.json() };
    } },
  };
  return { client, calls };
}

test('contrato quote: GPS e endereço manual retornam distância e frete esperados', async () => {
  for (const source of ['gps', 'nominatim_street']) {
    const { client } = integration({ signedIn: true });
    const quote = await quoteDeliveryRoute({ latitude: -48.01, longitude: -119.01, source }, client);
    assert.equal(quote.distanceKm, 2);
    assert.equal(quote.deliveryFee, 5);
    assert.equal(quote.allowed, true);
  }
});

for (const [label, signedIn, order] of [
  ['visitante/retirada', false, { delivery_type: 'retirada' }],
  ['cadastrado/manual', true, { delivery_type: 'entrega', location_source: 'address', geocoding_source: 'nominatim_street', latitude: -48.01, longitude: -119.01 }],
  ['GPS salvo', true, { delivery_type: 'entrega', location_source: 'gps', location_accuracy_m: 10, customer_address_id: 'saved-id', latitude: -48.01, longitude: -119.01 }],
  ['exceção postal', true, { delivery_type: 'entrega', location_source: 'address', geocoding_source: 'postal_zone', postal_code: '00000061' }],
]) {
  test(`contrato place_order: ${label}`, async () => {
    const { client, calls } = integration({ signedIn });
    const receipt = await placeRoutedOrder({ ...order, items: [{ product_id: 'test', quantity: 1 }] }, client, { expectedUserId: signedIn ? 'customer' : undefined });
    assert.equal(receipt.id, 'order-id');
    assert.equal(receipt.items[0].quantity, 1);
    assert.equal(receipt.total, 15);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'place_order_v4');
    assert.equal(calls[0].payload.p_actor_user_id, signedIn ? 'customer' : null);
    assert.equal(calls[0].payload.p_order.customer_address_id, order.customer_address_id);
    assert.equal(calls[0].payload.p_route.distance_km, order.latitude ? 2 : undefined);
  });
}

test('contrato 401: erro da Edge chega ao frontend sem chamar v4', async () => {
  const { client, calls } = integration({ signedIn: true, rejectIdentity: true });
  await assert.rejects(placeRoutedOrder({ delivery_type: 'retirada' }, client), error => error.code === 'AUTH_REQUIRED');
  assert.equal(calls.length, 0);
});
