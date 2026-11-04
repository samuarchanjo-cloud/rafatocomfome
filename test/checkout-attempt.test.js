import vm from "node:vm";
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { attemptCredential, completedAttempt, createCheckoutAttempt, readCheckoutAttempt, writeCheckoutAttempt } from "../src/lib/checkout-attempt.js";
import { recoverRoutedOrder } from "../src/lib/routing.js";

function browserStorage() {
  const entries = new Map();
  return { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: (key) => entries.delete(key) };
}

test("a tentativa sobrevive a recarregamento e o comprovante descarta o payload local", () => {
  const storage = browserStorage();
  const attempt = createCheckoutAttempt(null, { customer_name: "Fictício" });
  writeCheckoutAttempt(storage, attempt);
  assert.deepEqual(readCheckoutAttempt(storage), attempt);
  assert.match(attempt.secret, /^[a-f0-9]{64}$/);
  assert.notEqual(createCheckoutAttempt(null, {}).secret, attempt.secret);
  writeCheckoutAttempt(storage, completedAttempt(attempt));
  assert.deepEqual(readCheckoutAttempt(storage), { ...attemptCredential(attempt), actorId: null });
});

test("recuperação anônima não usa sessão de outra conta", async () => {
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: "different" }, expires_at: Date.now() / 1000 + 3600 } } }) },
    functions: { invoke: () => assert.fail("não deve chamar a função") },
  };
  await assert.rejects(recoverRoutedOrder({ id: "attempt", secret: "token" }, client, { expectedUserId: null }), { code: "AUTH_REQUIRED" });
});

test("homologação: concorrência, resposta perdida, recarregamento e isolamento", { skip: !process.env.CHECKOUT_STAGING_ANON_KEY }, async () => {
  // Fixed destination and fixture: this test cannot submit to production.
  const endpoint = "https://epnaaexmxgohurwpfury.supabase.co/functions/v1/delivery-routing";
  const key = process.env.CHECKOUT_STAGING_ANON_KEY;
  const order = {
    customer_name: "QA Concorrência", customer_phone: "00000000000", delivery_type: "retirada",
    payment_method: "dinheiro", items: [{ product_id: "teste-checkout", quantity: 1 }],
  };
  const storage = browserStorage();
  writeCheckoutAttempt(storage, createCheckoutAttempt(null, order));
  const call = async (body) => {
    const result = await fetch(endpoint, {
      method: "POST", headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    return { status: result.status, data: await result.json() };
  };
  const attempt = attemptCredential(readCheckoutAttempt(storage));
  const submit = { action: "place_order", attempt, order };
  const [discarded, received] = await Promise.all([call(submit), call(submit)]);
  assert.equal(discarded.status, 200, JSON.stringify(discarded.data));
  assert.equal(received.status, 200, JSON.stringify(received.data));
  assert.equal(received.data.id, discarded.data.id);
  assert.equal(received.data.items.length, 1);
  assert.equal(received.data.customer_id, null);
  // Simulate a refresh after the client lost the successful response.
  const restored = readCheckoutAttempt(storage);
  const recovered = await call({ action: "recover_order", attempt: attemptCredential(restored) });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.id, received.data.id);
  assert.equal((await call({ ...submit, attempt: attemptCredential(restored) })).data.id, received.data.id);
  assert.equal((await call({ ...submit, order: { ...order, notes: "different" } })).status, 409);
  assert.equal((await call({ action: "recover_order", attempt: { ...attempt, secret: "0".repeat(64) } })).status, 404);
  assert.equal((await call({ action: "recover_order", attempt: { ...attempt, id: crypto.randomUUID() } })).status, 404);
  const other = await call({ ...submit, attempt: attemptCredential(createCheckoutAttempt(null, order)) });
  assert.equal(other.status, 200);
  assert.notEqual(other.data.id, received.data.id);
  console.log(JSON.stringify({ checkedOrders: [received.data.id, other.data.id] }));
});

test("uma resposta perdida preserva a chave usada pelo checkout até a confirmação", async () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("  async function sendAttempt(");
  const end = app.indexOf("  async function resumeAttempt(", start);
  const storage = browserStorage();
  const attempt = createCheckoutAttempt(null, { customer_name: "Fictício" });
  writeCheckoutAttempt(storage, attempt);
  const calls = [];
  const send = vm.runInNewContext(app.slice(start, end) + "; sendAttempt", {
    attemptCredential, completedAttempt, saveAttempt: (value) => writeCheckoutAttempt(storage, value),
    placeOrder: async (_payload, options) => {
      calls.push(options.attempt);
      if (calls.length === 1) throw new Error("connection lost");
      return { id: "registered" };
    },
    setReceipt: (receipt) => assert.equal(receipt.id, "registered"), setCart() {},
    localStorage: browserStorage(), CHECKOUT_STORAGE_KEY: "draft", EMPTY_CHECKOUT: {},
    setCheckout() {}, setDeliveryLocation() {}, setAccountPassword() {},
  });
  await assert.rejects(send(attempt, { initial: true }), /connection lost/);
  await send(readCheckoutAttempt(storage));
  assert.deepEqual(calls, [attemptCredential(attempt), attemptCredential(attempt)]);
  assert.equal(readCheckoutAttempt(storage).payload, undefined);
});

test("a mesma mensagem é recuperável pelo comprovante e pelo histórico", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("  function buildWhatsappMessage(");
  const end = app.indexOf("  function customerAddressPayload(", start);
  const format = vm.runInNewContext(app.slice(start, end) + "; buildWhatsappMessage", {
    money: (value) => String(value), paymentLabels: { pix: "Pix" },
  });
  const order = { id: "fake-code-123", customer_name: "Fictício", customer_phone: "00000000",
    delivery_type: "retirada", payment_method: "pix", subtotal: 10, delivery_fee: 0, total: 10 };
  const receipt = format({ ...order, items: [{ name: "Lanche", quantity: 1 }] });
  assert.equal(format({ ...order, order_items: [{ product_name: "Lanche", quantity: 1 }] }), receipt);
  assert.match(receipt, /Código: fake-cod[\s\S]*1x Lanche[\s\S]*Total: 10/);
});