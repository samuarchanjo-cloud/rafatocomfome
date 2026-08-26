import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createDeviceGpsLocation, isTrustedDeliveryLocation, requestDeviceGps } from "../src/lib/location.js";
import { checkoutDraft, rebuildCartFromOrder, recommendProducts } from "../src/lib/customer.js";

const appUrl = new URL("../src/App.jsx", import.meta.url);
const apiUrl = new URL("../src/lib/api.js", import.meta.url);
const clientUrl = new URL("../src/lib/supabase.js", import.meta.url);
const edgeUrl = new URL("../supabase/functions/delivery-routing/index.ts", import.meta.url);
const migrationUrl = new URL("../supabase/migrations/20260829_customer_checkout.sql", import.meta.url);

test("GPS exige confirmação e precisão de até 150 metros", () => {
  assert.throws(() => createDeviceGpsLocation({ latitude: -22.9, longitude: -43.5, accuracy: 20 }), /Confirme/);
  assert.throws(() => createDeviceGpsLocation({ latitude: -22.9, longitude: -43.5, accuracy: 151 }, { confirmed: true }), /precisão/);
  const location = createDeviceGpsLocation({ latitude: -22.9, longitude: -43.5, accuracy: 20 }, { confirmed: true });
  assert.equal(location.source, "gps");
  assert.equal(location.locationSource, "gps");
  assert.equal(isTrustedDeliveryLocation(location), true);
});

test("GPS recusado produz fallback tratável sem inventar coordenadas", async () => {
  await assert.rejects(
    requestDeviceGps({
      confirmed: true,
      geolocation: { getCurrentPosition(_success, failure) { failure({ code: 1 }); } },
    }),
    (error) => error.code === "GPS_PERMISSION_DENIED" && /permissão/i.test(error.message),
  );
});

test("draft preserva checkout e localização, mas nunca senha", () => {
  const draft = checkoutDraft({ name: "Rafa", password: "segredo", accountPassword: "segredo", payment: "pix" }, { source: "gps" }, "checkout");
  assert.equal(draft.checkout.name, "Rafa");
  assert.equal(draft.checkout.password, undefined);
  assert.equal(draft.checkout.accountPassword, undefined);
  assert.equal(draft.view, "checkout");
});

test("recomendações excluem carrinho, ocultos e esgotados", () => {
  const products = [
    { id: "a", name: "A", category: "lanche", status: "Disponível", visible: true },
    { id: "b", name: "B", category: "bebida", status: "Disponível", visible: true },
    { id: "c", name: "C", category: "doce", status: "Esgotado", visible: true },
    { id: "d", name: "D", category: "doce", status: "Disponível", visible: false },
  ];
  assert.deepEqual(recommendProducts(products, [{ id: "a" }]).map((item) => item.id), ["b"]);
  assert.deepEqual(recommendProducts(products, [], { storeOpen: false }), []);
});

test("repetir pedido usa produtos e preços atuais e ignora indisponíveis", () => {
  const order = { order_items: [{ product_id: "a", product_name: "Antigo", quantity: 2 }, { product_id: "x", product_name: "Fora", quantity: 1 }] };
  const products = [{ id: "a", name: "Atual", price: 99, status: "Disponível", visible: true }];
  const result = rebuildCartFromOrder(order, products);
  assert.deepEqual(result.cart, [{ id: "a", qty: 2 }]);
  assert.deepEqual(result.unavailable, ["Fora"]);
});

test("cliente, endereço, RLS e RPC v4 são incrementais e privados", async () => {
  const [migration, edge, api, client, app] = await Promise.all([
    readFile(migrationUrl, "utf8"), readFile(edgeUrl, "utf8"), readFile(apiUrl, "utf8"),
    readFile(clientUrl, "utf8"), readFile(appUrl, "utf8"),
  ]);
  assert.match(migration, /create table if not exists public\.customer_profiles/i);
  assert.match(migration, /create table if not exists public\.customer_addresses/i);
  assert.match(migration, /add column if not exists customer_id uuid/i);
  assert.match(migration, /customer_id = auth\.uid\(\)/i);
  assert.match(migration, /own_order\.customer_id = auth\.uid\(\)/i);
  assert.match(migration, /CUSTOMER_ADDRESS_FORBIDDEN/);
  assert.match(migration, /abs\(v_saved_address\.latitude[\s\S]*CUSTOMER_ADDRESS_FORBIDDEN/i);
  assert.match(migration, /revoke all on function public\.place_order_v4[\s\S]*grant execute[\s\S]*service_role/i);
  assert.match(edge, /auth\.getUser\(bearer\)/);
  assert.match(edge, /p_actor_user_id: actorUserId/);
  assert.match(api, /signUpCustomer/);
  assert.match(api, /\.eq\("customer_id", userId\)/);
  assert.match(client, /persistSession: true/);
  assert.match(client, /autoRefreshToken: true/);
  assert.match(client, /detectSessionInUrl: true/);
  assert.match(app, /autoComplete="new-password"/);
  assert.match(app, /Continuar sem cadastro/);
  assert.doesNotMatch(migration, /(?:truncate|drop table)/i);
});

test("Uber permanece validado financeiramente pela RPC anterior e é exposto como taxa zero", async () => {
  const [migration, app] = await Promise.all([readFile(migrationUrl, "utf8"), readFile(appUrl, "utf8")]);
  assert.match(migration, /public\.place_order_v3\(v_core_order, p_route\)/);
  assert.match(app, /Quero retirar por Uber/);
  assert.match(app, /Taxa da loja: R\$ 0,00/);
  assert.match(app, /Uber pago separadamente pelo cliente/);
});
