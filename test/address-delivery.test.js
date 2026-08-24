import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { distanceInKm, effectiveDeliveryDistance, evaluateOrderDelivery } from "../src/lib/delivery.js";
import { locateDeliveryAddress } from "../src/lib/geocodingProvider.js";
import {
  createDeviceGpsLocation,
  DEVICE_GPS_OPTIONS,
  isTrustedDeliveryLocation,
  MAX_DEVICE_GPS_ACCURACY_M,
  MIN_ADDRESS_UNCERTAINTY_M,
  requestDeviceGps,
} from "../src/lib/location.js";

const CABUCU = {
  postalCode: "23036-060", street: "Estrada Cabuçu de Baixo", number: "388",
  neighborhood: "Guaratiba", city: "Rio de Janeiro", state: "RJ",
};
const GIORDANO = {
  postalCode: "23036-050", street: "Rua Giordano Vincenzo", number: "515",
  neighborhood: "Guaratiba", city: "Rio de Janeiro", state: "RJ",
};
const LOLITA = {
  postalCode: "23036-061", street: "Rua Lolita Rodrigues", number: "285",
  neighborhood: "Guaratiba", city: "Rio de Janeiro", state: "RJ",
};
const WALDIR = {
  postalCode: "23036-076", street: "Rua Waldir José de Melo", number: "71",
  neighborhood: "Guaratiba", city: "Rio de Janeiro", state: "RJ",
};
const STORE = { latitude: -22.943800658459434, longitude: -43.582438704219854 };
const SETTINGS = { maximum_delivery_distance_km: 3.5, below_one_km_behavior: "fixed", below_one_km_fee: 3 };
const RANGES = [{ min_distance_km: 1, max_distance_km: 3.5, fee: 5, active: true }];

function response(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

function viaCep(address) {
  return {
    cep: address.postalCode,
    logradouro: address.street,
    bairro: address.neighborhood,
    localidade: address.city,
    uf: address.state,
  };
}

function nominatimCandidate({
  address = CABUCU,
  latitude = -22.944,
  longitude = -43.582,
  houseNumber = address.number,
  postalCode = address.postalCode,
  road = address.street,
  city = address.city,
  state = "Rio de Janeiro",
  stateIso = state === "São Paulo" ? "BR-SP" : "BR-RJ",
  type = houseNumber ? "house" : "residential",
  addresstype = houseNumber ? "house" : "road",
} = {}) {
  return {
    lat: String(latitude),
    lon: String(longitude),
    type,
    addresstype,
    display_name: `${road}, ${city}, ${postalCode}`,
    address: {
      ...(houseNumber ? { house_number: String(houseNumber) } : {}),
      road,
      suburb: address.neighborhood,
      city,
      state,
      "ISO3166-2-lvl4": stateIso,
      postcode: postalCode,
      country_code: "br",
    },
  };
}

async function loadAddressModule(name) {
  return import(`../src/lib/address.js?test=${name}-${Date.now()}-${Math.random()}`);
}

function installFetchMock({ address = CABUCU, viaCepAddress = address, candidates = [], nominatimError = null }) {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.hostname === "viacep.com.br") return response(viaCep(viaCepAddress));
    if (url.hostname === "nominatim.openstreetmap.org") {
      if (nominatimError) throw nominatimError;
      return response(typeof candidates === "function" ? candidates() : candidates);
    }
    throw new Error(`Fallback inesperado: ${url.hostname}`);
  };
  return calls;
}

function assessLocation(location) {
  const centerKm = distanceInKm(STORE, location);
  const km = effectiveDeliveryDistance(centerKm, location);
  const assessment = evaluateOrderDelivery("entrega", { ...location, centerKm, km }, RANGES, SETTINGS);
  return { centerKm, km, assessment };
}

function coordinatesAtDistance(km, accuracy = 20) {
  return createDeviceGpsLocation({
    latitude: STORE.latitude + (km / 111.195), longitude: STORE.longitude, accuracy,
  }, { confirmed: true });
}

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
let clock = 1_800_000_000_000;
Date.now = () => { clock += 1_001; return clock; };
test.after(() => { globalThis.fetch = originalFetch; Date.now = originalDateNow; });

test("baseline restaurada consulta uma vez o endereço completo e aceita número residencial compatível", async () => {
  const latitude = STORE.latitude + (0.6 / 111.195);
  const calls = installFetchMock({
    address: GIORDANO,
    candidates: [nominatimCandidate({ address: GIORDANO, latitude, longitude: STORE.longitude })],
  });
  const { geocodeDeliveryAddress } = await loadAddressModule("exact-inside");
  const location = await geocodeDeliveryAddress(GIORDANO);
  const { centerKm, assessment } = assessLocation(location);

  assert.equal(location.source, "nominatim_exact");
  assert.equal(location.precision, "exact");
  assert.equal(isTrustedDeliveryLocation(location), true);
  assert.ok(centerKm > 0.59 && centerKm < 0.61);
  assert.equal(assessment.allowed, true);
  assert.equal(assessment.fee, 3);

  const nominatimCalls = calls.filter((value) => new URL(value).hostname === "nominatim.openstreetmap.org");
  assert.equal(nominatimCalls.length, 1);
  const url = new URL(nominatimCalls[0]);
  assert.match(url.searchParams.get("q"), /Rua Giordano Vincenzo, 515, Guaratiba, Rio de Janeiro - RJ, 23036-050, Brasil/);
  assert.equal(url.searchParams.get("countrycodes"), "br");
  assert.equal(url.searchParams.has("street"), false);
  assert.equal(url.searchParams.has("viewbox"), false);
});

test("endereço residencial preciso acima de 3,5 km continua bloqueado normalmente", async () => {
  const latitude = STORE.latitude + (4 / 111.195);
  installFetchMock({ candidates: [nominatimCandidate({ latitude, longitude: STORE.longitude })] });
  const { geocodeDeliveryAddress } = await loadAddressModule("exact-outside");
  const location = await geocodeDeliveryAddress(CABUCU);
  const { assessment } = assessLocation(location);
  assert.equal(assessment.allowed, false);
  assert.equal(assessment.code, "OUTSIDE_AREA");
});

test("endereço residencial preciso entre 1 e 3,5 km usa a faixa existente", async () => {
  const latitude = STORE.latitude + (2 / 111.195);
  installFetchMock({ candidates: [nominatimCandidate({ latitude, longitude: STORE.longitude })] });
  const { geocodeDeliveryAddress } = await loadAddressModule("exact-range");
  const location = await geocodeDeliveryAddress(CABUCU);
  const { assessment } = assessLocation(location);
  assert.equal(assessment.allowed, true);
  assert.equal(assessment.code, "RANGE");
  assert.equal(assessment.fee, 5);
});

test("resultado somente de rua não vira coordenada financeira e não aciona AwesomeAPI", async () => {
  const calls = installFetchMock({ candidates: [nominatimCandidate({ houseNumber: null })] });
  const { geocodeDeliveryAddress } = await loadAddressModule("road-only");
  await assert.rejects(geocodeDeliveryAddress(CABUCU), (error) => error.code === "ADDRESS_NOT_PRECISE");
  assert.equal(calls.filter((value) => new URL(value).hostname === "nominatim.openstreetmap.org").length, 1);
  assert.equal(calls.some((value) => new URL(value).hostname === "cep.awesomeapi.com.br"), false);
});

test("número residencial diferente continua sendo rejeitado", async () => {
  installFetchMock({ candidates: [nominatimCandidate({ houseNumber: "999" })] });
  const { geocodeDeliveryAddress } = await loadAddressModule("wrong-number");
  await assert.rejects(geocodeDeliveryAddress(CABUCU), (error) => error.code === "ADDRESS_NOT_PRECISE");
});

test("rua, cidade, estado e CEP retornados precisam ser compatíveis", async () => {
  const incompatibleCandidates = [
    nominatimCandidate({ road: "Rua Diferente" }),
    nominatimCandidate({ city: "Niterói" }),
    nominatimCandidate({ state: "São Paulo" }),
    nominatimCandidate({ postalCode: "23036-999" }),
  ];
  installFetchMock({ candidates: incompatibleCandidates });
  const { geocodeDeliveryAddress } = await loadAddressModule("incompatible-result");
  await assert.rejects(geocodeDeliveryAddress(CABUCU), (error) => error.code === "ADDRESS_NOT_PRECISE");
});

test("ViaCEP incompatível interrompe a resolução antes do Nominatim", async () => {
  const calls = installFetchMock({ viaCepAddress: { ...CABUCU, street: "Rua Incompatível" } });
  const { geocodeDeliveryAddress } = await loadAddressModule("viacep-mismatch");
  await assert.rejects(
    geocodeDeliveryAddress(CABUCU),
    (error) => error.code === "ADDRESS_POSTAL_CODE_MISMATCH",
  );
  assert.equal(calls.some((value) => new URL(value).hostname === "nominatim.openstreetmap.org"), false);
});

test("indisponibilidade do Nominatim não usa CEP ou AwesomeAPI como substituto", async () => {
  const calls = installFetchMock({ nominatimError: new TypeError("network timeout") });
  const { geocodeDeliveryAddress } = await loadAddressModule("nominatim-timeout");
  await assert.rejects(geocodeDeliveryAddress(CABUCU), (error) => error.code === "GEOCODING_UNAVAILABLE");
  assert.equal(calls.some((value) => new URL(value).hostname === "cep.awesomeapi.com.br"), false);
});

test("falha não é armazenada no cache e nova tentativa pode encontrar o número", async () => {
  let candidates = [];
  installFetchMock({ candidates: () => candidates });
  const { geocodeDeliveryAddress } = await loadAddressModule("exact-retry");
  await assert.rejects(geocodeDeliveryAddress(CABUCU), (error) => error.code === "ADDRESS_NOT_PRECISE");
  candidates = [nominatimCandidate()];
  const location = await geocodeDeliveryAddress(CABUCU);
  assert.equal(location.source, "nominatim_exact");
});

test("quatro CEPs de regressão não aceitam os resultados aproximados observados", async () => {
  const cases = [
    [LOLITA, [nominatimCandidate({ address: LOLITA, houseNumber: null, postalCode: "23030-440", latitude: -22.9480261, longitude: -43.5844627 })]],
    [WALDIR, []],
    [CABUCU, [
      nominatimCandidate({ houseNumber: null, postalCode: "23036-053", latitude: -22.940458, longitude: -43.5799353 }),
      nominatimCandidate({ houseNumber: null, postalCode: "23030-440", latitude: -22.9451175, longitude: -43.5820797 }),
    ]],
    [GIORDANO, []],
  ];

  for (const [address, candidates] of cases) {
    const calls = installFetchMock({ address, candidates });
    const { geocodeDeliveryAddress } = await loadAddressModule(`regression-${address.postalCode}`);
    await assert.rejects(
      geocodeDeliveryAddress(address),
      (error) => error.code === "ADDRESS_NOT_PRECISE",
      address.postalCode,
    );
    assert.equal(calls.filter((value) => new URL(value).hostname === "nominatim.openstreetmap.org").length, 1);
    assert.equal(calls.some((value) => new URL(value).hostname === "cep.awesomeapi.com.br"), false);
  }
});

test("provedor automático delega somente à resolução exata do Nominatim", async () => {
  const calls = installFetchMock({ candidates: [nominatimCandidate()] });
  const location = await locateDeliveryAddress(CABUCU);
  assert.equal(location.source, "nominatim_exact");
  assert.deepEqual(
    [...new Set(calls.map((value) => new URL(value).hostname))],
    ["viacep.com.br", "nominatim.openstreetmap.org"],
  );
});

test("checkout consulta regra por CEP e bairro após ADDRESS_NOT_PRECISE, sem GPS ou mapa", async () => {
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const validation = app.slice(app.indexOf("async function validateDeliveryAddress"), app.indexOf("function changeDeliveryLocation"));
  assert.match(validation, /error\.code === "ADDRESS_NOT_PRECISE"/);
  assert.match(validation, /resolveDeliveryArea\(checkout\.postalCode, checkout\.neighborhood/);
  assert.match(validation, /createPostalZoneLocation\(zone, checkout\.postalCode, checkout\.neighborhood\)/);
  assert.match(validation, /type: "unavailable"/);
  assert.match(validation, /Este endereço ainda não está disponível para entrega\./);
  assert.doesNotMatch(validation, /requestDeviceGps|device_gps/);
  assert.doesNotMatch(validation, /openMapPicker\(/);
});

test("regras históricas de consenso permanecem compatíveis, mas não são produzidas pelo geocodificador", () => {
  const location = {
    latitude: STORE.latitude + (2 / 111.195),
    longitude: STORE.longitude,
    source: "address_consensus",
    precision: "consensus",
    uncertainty: MIN_ADDRESS_UNCERTAINTY_M,
  };
  const { km, assessment } = assessLocation(location);
  assert.equal(km, 2.75);
  assert.equal(assessment.allowed, true);
  assert.equal(assessment.fee, 5);
});

test("retirada no local continua sem exigir localização", () => {
  assert.deepEqual(evaluateOrderDelivery("retirada", null, RANGES, SETTINGS), {
    allowed: true,
    fee: 0,
    code: "PICKUP",
    message: "Retirada no local.",
  });
});

test("suporte histórico de GPS permanece isolado e não é consultado pela resolução automática", async () => {
  assert.equal(MAX_DEVICE_GPS_ACCURACY_M, 150);
  assert.throws(() => coordinatesAtDistance(0.6, 200), (error) => error.code === "GPS_INACCURATE");
  assert.deepEqual(DEVICE_GPS_OPTIONS, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });

  let requested = false;
  await assert.rejects(
    requestDeviceGps({
      confirmed: false,
      geolocation: { getCurrentPosition() { requested = true; } },
    }),
    (error) => error.code === "GPS_CONFIRMATION_REQUIRED",
  );
  assert.equal(requested, false);
});
