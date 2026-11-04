import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { validateDeliveryAddressFields } from '../src/lib/address.js';
import { isTrustedDeliveryLocation } from '../src/lib/location.js';
import { savedAddressToCheckout, invalidateEditedAddress, saveOptionalCheckoutAddress } from '../src/lib/customer.js';
import { createPostalZoneLocation } from '../src/lib/postalZone.js';
import { placeRoutedOrder } from '../src/lib/routing.js';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function method(name, next, context) {
  const start = app.indexOf(`  async function ${name}(`);
  return vm.runInNewContext(`${app.slice(start, app.indexOf(`  ${next}`, start))}; ${name}`, context);
}

test('F04: falha opcional no perfil não rejeita preparação de cliente cadastrado', async () => {
  const prepare = method('prepareCustomerForOrder', 'async function finishOrder', {
    session: { user: { id: 'customer', email: 'synthetic@example.test' } },
    checkout: { deliveryType: 'retirada', accountChoice: 'guest' }, account: { profile: null },
    saveCustomerProfile: async () => { throw new Error('profile offline'); },
    showNotice() {},
  });
  await assert.doesNotReject(prepare());
});

test('F07: finalizar GPS salvo sem CEP chega à criação do pedido', async () => {
  let created = false;
  const finish = method('finishOrder', 'function saveAttempt', {
    session: null, readCheckoutAttempt: () => null, sessionStorage: {}, submittingRef: { current: false }, getBusinessStatus: () => ({ open: true }),
    store: { businessHours: [], settings: {} }, cartLines: [{ id: 'p', qty: 1 }],
    checkout: { deliveryType: 'entrega', locationFlow: 'saved', street: 'Rua Teste', number: '1', reference: '', notes: '' },
    deliveryLocation: { source: 'gps', locationSource: 'gps', accuracy: 10, latitude: -48, longitude: -119 },
    validateDeliveryAddressFields, isTrustedDeliveryLocation: () => true, deliveryAllowed: true,
    setSubmittingOrder() {}, prepareCustomerForOrder: async () => null,
    composeDeliveryAddress: () => 'Rua Teste, 1', postalCodeDigits: () => '',
    getSession: async () => null, createCheckoutAttempt: (_actor, payload) => ({ payload }), saveAttempt() {},
    sendAttempt: async ({ payload }) => { assert.equal(payload.location_source, 'gps'); created = true; },
    showNotice() {}, console: { error() {} }, friendlyOrderError: () => 'test', reloadStore: async () => {},
  });
  await finish({ preventDefault() {} });
  assert.equal(created, true);
});

function preparation(overrides = {}) {
  const calls = [];
  const context = {
    session: { user: { id: 'customer', email: 'synthetic@example.test' } },
    checkout: { deliveryType: 'entrega', locationFlow: 'address', accountChoice: 'guest', saveAddress: true, name: 'Teste', phone: '00000000', accountEmail: 'synthetic@example.test' },
    accountPassword: 'synthetic-password', account: { profile: null },
    saveOptionalCheckoutAddress,
    saveCustomerProfile: async () => { calls.push('profile'); },
    saveCustomerAddress: async () => { calls.push('address'); return { id: 'saved-id' }; },
    customerAddressPayload: () => ({}), setCheckout() {}, setSession() {},
    showNotice: (message) => calls.push(message), ...overrides,
  };
  return { calls, run: method('prepareCustomerForOrder', 'async function finishOrder', context) };
}

test('visitante não chama cadastro, perfil ou endereço', async () => {
  const { calls, run } = preparation({ session: null });
  assert.equal(await run(), null);
  assert.deepEqual(calls, []);
});

test('cliente cadastrado sem perfil em cache não precisa salvar perfil para comprar', async () => {
  const { calls, run } = preparation({ checkout: { deliveryType: 'retirada' } });
  assert.equal(await run(), null);
  assert.deepEqual(calls, []);
});

for (const stage of ['profile', 'address']) {
  test(`F04: falha opcional de ${stage} permite continuar sem vínculo de endereço`, async () => {
    const { calls, run } = preparation({
      ...(stage === 'profile' ? { saveCustomerProfile: async () => { throw new Error('offline'); } }
        : { saveCustomerAddress: async () => { throw new Error('offline'); } }),
    });
    assert.equal(await run(), null);
    assert.match(calls.at(-1), /pedido continuará/);
  });
}

test('cliente novo recebe sessão e salva endereço; signup sem sessão continua como visitante', async () => {
  for (const session of [null, { user: { id: 'new', email: 'synthetic@example.test' } }]) {
    const { run } = preparation({ session: null,
      checkout: { deliveryType: 'entrega', accountChoice: 'save', accountEmail: 'synthetic@example.test' },
      signUpCustomer: async () => ({ session }),
    });
    assert.equal(await run(), session ? 'saved-id' : null);
  }
});

test('signup rejeitado orienta login ou compra sem cadastro', async () => {
  const { run } = preparation({ session: null,
    checkout: { accountChoice: 'save', accountEmail: 'synthetic@example.test' },
    signUpCustomer: async () => { throw new Error('email exists'); },
  });
  await assert.rejects(run(), /Continuar sem cadastro/);
});

test('endereço editado não envia vínculo antigo após falha no salvamento opcional', async () => {
  const { run } = preparation({ checkout: { deliveryType: 'entrega', locationFlow: 'address', customerAddressId: 'old', saveAddress: true },
    saveCustomerAddress: async () => { throw new Error('offline'); },
  });
  assert.equal(await run(), null);
});

test('GPS salvo mantém vínculo ao usuário; retirada nunca envia ID de endereço', async () => {
  for (const deliveryType of ['entrega', 'retirada']) {
    const { run } = preparation({ checkout: { deliveryType, locationFlow: 'saved', customerAddressId: 'saved-id' } });
    assert.equal(await run(), deliveryType === 'entrega' ? 'saved-id' : null);
  }
});

test('editar rua/número invalida coordenadas; rótulo/complemento mantém localização', () => {
  const saved = { street: 'Rua A', number: '1', latitude: -48, longitude: -119, location_source: 'gps', location_accuracy: 10 };
  const edited = invalidateEditedAddress({ ...saved, street: 'Rua B' }, saved);
  assert.equal(edited.latitude, null);
  assert.equal(edited.location_source, 'address');
  const label = { ...saved, label: 'Trabalho', complement: 'Apto 2' };
  assert.equal(invalidateEditedAddress(label, saved), label);
});

test('F05: null/vazio nunca são localização confiável, GPS válido continua aceito', () => {
  for (const latitude of [null, undefined, '', ' ']) {
    assert.equal(isTrustedDeliveryLocation({ latitude, longitude: -119, source: 'gps', precision: 'exact', accuracy: 10 }), false);
  }
  assert.equal(isTrustedDeliveryLocation({ latitude: -48, longitude: -119, source: 'gps', precision: 'exact', accuracy: 10 }), true);
});

test('F05: saved postal_zone revalida CEP e obtém taxa atual sem cotar coordenadas', async () => {
  const calls = [];
  let checkout = {};
  let location;
  const context = {
    AbortController, geocodingAbortRef: { current: null },
    savedAddressToCheckout, validateDeliveryAddressFields, isTrustedDeliveryLocation, createPostalZoneLocation,
    setCheckout: fn => { checkout = fn(checkout); }, setDeliveryLocation: value => { location = value; },
    setAddressValidationStatus() {}, setValidatingAddress() {},
    validateDeliveryPostalAddress: async fields => { calls.push('postal'); return fields; },
    resolveDeliveryArea: async () => { calls.push('zone'); return { id: 'zone', matchType: 'exact', deliveryFee: 7 }; },
    friendlyOrderError: error => error.message,
  };
  context.validateDeliveryAddress = method('validateDeliveryAddress', 'function changeDeliveryLocation', context);
  const useSaved = method('useSavedAddress', 'function editSavedAddress', context);
  await useSaved({ id: 'saved', street: 'Rua Teste', number: '1', postcode: '00000061', neighborhood: 'Teste', city: 'Cidade Ficticia', state: 'RJ', latitude: null, longitude: null, location_source: 'address', geocoding_source: 'postal_zone' });
  assert.deepEqual(calls, ['postal', 'zone']);
  assert.equal(location.source, 'postal_zone');
  assert.equal(location.deliveryFee, 7);
  assert.equal(checkout.customerAddressId, null);
});

test('resposta atrasada de rota não restaura endereço substituído', async () => {
  let resolve;
  const controller = new AbortController();
  let location = null;
  const context = {
    geocodingAbortRef: { current: controller },
    resolveDeliveryCoordinates: () => new Promise(done => { resolve = done; }),
    setDeliveryLocation: value => { location = value; }, setCheckout() {}, setAddressValidationStatus() {},
  };
  const accept = method('acceptResolvedLocation', 'function chooseManualAddress', context);
  const request = accept({ latitude: -48, longitude: -119 });
  controller.abort();
  resolve({ location: { latitude: -48 }, assessment: { allowed: true } });
  await request;
  assert.equal(location, null);
});

test('endereço manual salvo usa texto atual no geocoder, sem reaproveitar coordenadas antigas', async () => {
  let located;
  let accepted;
  const fields = { street: 'Rua Atual', number: '25', postalCode: '00000061', neighborhood: 'Teste', city: 'Cidade Ficticia', state: 'RJ' };
  const context = {
    AbortController, geocodingAbortRef: { current: null }, validateDeliveryAddressFields, createPostalZoneLocation, isTrustedDeliveryLocation,
    store: { settings: { maximum_delivery_distance_km: 3.5, store_latitude: -48, store_longitude: -119 } },
    setDeliveryLocation() {}, setAddressValidationStatus() {}, setValidatingAddress() {},
    validateDeliveryPostalAddress: async address => address, resolveDeliveryArea: async () => null,
    locateDeliveryAddress: async address => { located = address; return { latitude: -48.01, longitude: -119.01, source: 'nominatim_street', precision: 'street' }; },
    acceptResolvedLocation: async location => { accepted = location; }, friendlyOrderError: error => error.message,
  };
  const validate = method('validateDeliveryAddress', 'function changeDeliveryLocation', context);
  await validate(fields);
  assert.equal(located, fields);
  assert.equal(accepted.latitude, -48.01);
  assert.equal(accepted.locationSource, 'address');
  assert.equal(accepted.geocodingSource, 'nominatim_street');
});

test('mensagens distinguem sessão, serviço ausente, endereço e resposta desconhecida', () => {
  const start = app.indexOf('function friendlyOrderError(');
  const friendly = vm.runInNewContext(`${app.slice(start, app.indexOf('function App()', start))}; friendlyOrderError`);
  assert.match(friendly({ code: 'AUTH_REQUIRED', message: 'non-2xx' }), /Entre novamente/);
  assert.match(friendly({ code: 'PGRST202' }), /serviço de pedidos está indisponível/);
  assert.match(friendly({ code: 'CUSTOMER_ADDRESS_FORBIDDEN' }), /Selecione-o novamente/);
  assert.match(friendly({ code: 'ROUTING_UNAVAILABLE' }), /Verificar ou retomar pedido/);
});

function routingClient(session, { refreshError, invokeError } = {}) {
  const calls = [];
  const client = {
    auth: {
      getSession: async () => ({ data: { session } }),
      refreshSession: async () => { calls.push('refresh'); return { error: refreshError, data: { session: refreshError ? null : { ...session, access_token: 'fresh', expires_at: Date.now() / 1000 + 3600 } } }; },
    },
    functions: { invoke: async (_name, options) => { calls.push(options); return { data: { id: 'order' }, error: invokeError }; } },
  };
  return { client, calls };
}

test('visitante usa Edge sem exigir conta; cliente persistente envia bearer atual', async () => {
  for (const session of [null, { access_token: 'current', expires_at: Date.now() / 1000 + 3600, user: { id: 'customer' } }]) {
    const { client, calls } = routingClient(session);
    await placeRoutedOrder({ delivery_type: 'retirada' }, client);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers?.Authorization, session ? 'Bearer current' : undefined);
  }
});

test('sessão expirada renova antes de uma única submissão', async () => {
  const { client, calls } = routingClient({ access_token: 'old', expires_at: 1, user: { id: 'customer' } });
  await placeRoutedOrder({}, client, { expectedUserId: 'customer' });
  assert.equal(calls[0], 'refresh');
  assert.equal(calls[1].headers.Authorization, 'Bearer fresh');
  assert.equal(calls.length, 2);
});

test('refresh inválido ou sessão trocada não envia pedido como visitante silenciosamente', async () => {
  const expired = routingClient({ expires_at: 1, user: { id: 'customer' } }, { refreshError: new Error('expired') });
  await assert.rejects(placeRoutedOrder({}, expired.client), error => error.code === 'AUTH_REQUIRED');
  assert.deepEqual(expired.calls, ['refresh']);
  const missing = routingClient(null);
  await assert.rejects(placeRoutedOrder({}, missing.client, { expectedUserId: 'customer' }), error => error.code === 'AUTH_REQUIRED');
  assert.deepEqual(missing.calls, []);
});

test('401 do gateway tem código de sessão e não causa retry da criação', async () => {
  const { client, calls } = routingClient(null, { invokeError: { message: 'non-2xx', context: new Response(JSON.stringify({ message: 'Invalid JWT' }), { status: 401 }) } });
  await assert.rejects(placeRoutedOrder({}, client), error => error.code === 'AUTH_REQUIRED');
  assert.equal(calls.length, 1);
});

test('erro de RPC preserva código para mensagem orientada ao cliente', async () => {
  const { client } = routingClient(null, { invokeError: { context: new Response(JSON.stringify({ error: 'CUSTOMER_ADDRESS_FORBIDDEN' }), { status: 400 }) } });
  await assert.rejects(placeRoutedOrder({}, client), error => error.code === 'CUSTOMER_ADDRESS_FORBIDDEN');
});

test('gravação opcional travada expira e não inicia endereço após perfil tardio', async () => {
  let release;
  let addressCalls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  await assert.rejects(saveOptionalCheckoutAddress({
    saveProfile: () => pending,
    saveAddress: () => { addressCalls++; },
  }, 5), /OPTIONAL_SAVE_TIMEOUT/);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(addressCalls, 0);
});

test('timeout opcional propaga abort à escrita de endereço', async () => {
  let signal;
  await assert.rejects(saveOptionalCheckoutAddress({ saveAddress: current => {
    signal = current;
    return new Promise(() => {});
  } }, 5), /OPTIONAL_SAVE_TIMEOUT/);
  assert.equal(signal.aborted, true);
});
