import assert from "node:assert/strict";
import test from "node:test";

import { distanceInKm, evaluateOrderDelivery } from "../src/lib/delivery.js";
import {
  createDeviceGpsLocation,
  DEVICE_GPS_OPTIONS,
  isTrustedDeliveryLocation,
  MAX_DEVICE_GPS_ACCURACY_M,
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
const STORE = { latitude: -22.943800658459434, longitude: -43.582438704219854 };
const SETTINGS = { maximum_delivery_distance_km: 3.5, below_one_km_behavior: "fixed", below_one_km_fee: 3 };
const RANGES = [{ min_distance_km: 1, max_distance_km: 3.5, fee: 5, active: true }];

function response(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

function viaCep(address) {
  return { cep: address.postalCode, logradouro: address.street, bairro: address.neighborhood, localidade: address.city, uf: address.state };
}

function nominatimCandidate({
  address = CABUCU, latitude = -22.944, longitude = -43.582, houseNumber,
  postalCode = address.postalCode, type = houseNumber ? "house" : "residential",
  addresstype = houseNumber ? "house" : "road", category = houseNumber ? "place" : "highway",
  placeRank = houseNumber ? 30 : 26,
} = {}) {
  return {
    lat: String(latitude), lon: String(longitude), type, addresstype, category, place_rank: placeRank,
    display_name: `${address.street}, ${address.city}, ${postalCode}`,
    address: {
      ...(houseNumber ? { house_number: String(houseNumber) } : {}),
      road: address.street, suburb: address.neighborhood, city: address.city, state: "Rio de Janeiro",
      "ISO3166-2-lvl4": "BR-RJ", postcode: postalCode, country_code: "br",
    },
  };
}

function awesomeResult({ address = CABUCU, latitude = -22.9441, longitude = -43.5821 } = {}) {
  return {
    cep: address.postalCode.replace(/\D/g, ""), address: address.street, district: address.neighborhood,
    city: address.city, state: address.state, address_type: "Rua", lat: String(latitude), lng: String(longitude),
  };
}

async function loadAddressModule(name) {
  return import(`../src/lib/address.js?test=${name}-${Date.now()}-${Math.random()}`);
}

function installFetchMock({ address = CABUCU, exact = [], approximate = [], awesome = null, exactError = null }) {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.hostname === "viacep.com.br") return response(viaCep(address));
    if (url.hostname === "nominatim.openstreetmap.org") {
      const query = url.searchParams.get("q") || "";
      if (query.includes(`, ${address.number},`)) {
        if (exactError) throw exactError;
        return response(typeof exact === "function" ? exact() : exact);
      }
      return response(typeof approximate === "function" ? approximate() : approximate);
    }
    if (url.hostname === "cep.awesomeapi.com.br") {
      return awesome ? response(typeof awesome === "function" ? awesome() : awesome) : response({}, { ok: false, status: 404 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  return calls;
}

function coordinatesAtDistance(km, accuracy = 20) {
  return createDeviceGpsLocation({
    latitude: STORE.latitude + (km / 111.195), longitude: STORE.longitude, accuracy,
  }, { confirmed: true });
}

function assessLocation(location) {
  const km = distanceInKm(STORE, location);
  return { km, assessment: evaluateOrderDelivery("entrega", { ...location, km }, RANGES, SETTINGS) };
}

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
let clock = 1_800_000_000_000;
Date.now = () => { clock += 1_001; return clock; };
test.after(() => { globalThis.fetch = originalFetch; Date.now = originalDateNow; });

test("CASO 1: endereço exato dentro de 3,5 km é aceito", async () => {
  installFetchMock({ address: GIORDANO, exact: [nominatimCandidate({ address: GIORDANO, houseNumber: GIORDANO.number })] });
  const { geocodeDeliveryAddress } = await loadAddressModule("giordano-exact-inside");
  const location = await geocodeDeliveryAddress(GIORDANO);
  const { assessment } = assessLocation(location);
  assert.equal(location.source, "nominatim_exact");
  assert.equal(isTrustedDeliveryLocation(location), true);
  assert.equal(assessment.allowed, true);
  assert.equal(assessment.fee, 3);
});

test("CASO 2: endereço exato acima de 3,5 km continua OUTSIDE_AREA", async () => {
  const farLatitude = STORE.latitude + (5 / 111.195);
  installFetchMock({ exact: [nominatimCandidate({ houseNumber: CABUCU.number, latitude: farLatitude, longitude: STORE.longitude })] });
  const { geocodeDeliveryAddress } = await loadAddressModule("exact-outside");
  const location = await geocodeDeliveryAddress(CABUCU);
  const { assessment } = assessLocation(location);
  assert.equal(isTrustedDeliveryLocation(location), true);
  assert.equal(assessment.allowed, false);
  assert.equal(assessment.code, "OUTSIDE_AREA");
});

test("CASO 3: número ausente e CEP a 600 m não calculam taxa", async () => {
  const latitude = STORE.latitude + (0.6 / 111.195);
  installFetchMock({ approximate: [nominatimCandidate({ latitude, longitude: STORE.longitude })], awesome: awesomeResult({ latitude, longitude: STORE.longitude }) });
  const { geocodeDeliveryAddress } = await loadAddressModule("cabucu-auxiliary-only");
  const location = await geocodeDeliveryAddress(CABUCU);
  assert.equal(location.precision, "approximate");
  assert.equal(isTrustedDeliveryLocation(location), false);
  assert.equal(evaluateOrderDelivery("entrega", null, RANGES, SETTINGS).code, "LOCATION_REQUIRED");
});

test("CASO 4: GPS confirmado a 600 m é aceito com a taxa abaixo de 1 km", () => {
  const location = coordinatesAtDistance(0.6);
  const { km, assessment } = assessLocation(location);
  assert.equal(location.source, "device_gps");
  assert.equal(isTrustedDeliveryLocation(location), true);
  assert.ok(km > 0.59 && km < 0.61);
  assert.equal(assessment.allowed, true);
  assert.equal(assessment.fee, 3);
});

test("CASO 5: GPS confirmado a 5 km continua OUTSIDE_AREA", () => {
  const { assessment } = assessLocation(coordinatesAtDistance(5));
  assert.equal(assessment.allowed, false);
  assert.equal(assessment.code, "OUTSIDE_AREA");
});

test("CASO 6: GPS atual a 24 km calcula a posição real e bloqueia", () => {
  const location = coordinatesAtDistance(24);
  const { km, assessment } = assessLocation(location);
  assert.equal(location.source, "device_gps");
  assert.ok(km > 23.9 && km < 24.1);
  assert.equal(assessment.code, "OUTSIDE_AREA");
});

test("CASO 7: GPS acima do limite de precisão é rejeitado", () => {
  assert.equal(MAX_DEVICE_GPS_ACCURACY_M, 150);
  assert.throws(
    () => coordinatesAtDistance(0.6, 200),
    (error) => error.code === "GPS_INACCURATE" && error.message.includes("precisão suficiente"),
  );
});

test("CASO 8: permissão de GPS negada orienta sem aceitar coordenada", async () => {
  let receivedOptions;
  const geolocation = { getCurrentPosition(_success, error, options) { receivedOptions = options; error({ code: 1 }); } };
  await assert.rejects(
    requestDeviceGps({ confirmed: true, geolocation }),
    (error) => error.code === "GPS_PERMISSION_DENIED" && error.message.includes("revise o endereço"),
  );
  assert.equal(receivedOptions.enableHighAccuracy, true);
  assert.deepEqual(receivedOptions, DEVICE_GPS_OPTIONS);
});

test("GPS exige confirmação semântica antes de consultar o aparelho", async () => {
  let requested = false;
  const geolocation = { getCurrentPosition() { requested = true; } };
  await assert.rejects(
    requestDeviceGps({ confirmed: false, geolocation }),
    (error) => error.code === "GPS_CONFIRMATION_REQUIRED",
  );
  assert.equal(requested, false);
});

test("CASO 9: timeout do Nominatim deixa coordenada auxiliar e GPS disponível", async () => {
  installFetchMock({ exactError: new TypeError("network timeout"), awesome: awesomeResult() });
  const { geocodeDeliveryAddress } = await loadAddressModule("nominatim-timeout");
  const location = await geocodeDeliveryAddress(CABUCU);
  assert.equal(location.source, "awesomeapi_cep");
  assert.equal(isTrustedDeliveryLocation(location), false);
  assert.equal(typeof requestDeviceGps, "function");
});

test("CASO 10: fontes aproximadas próximas permanecem apenas auxiliares", async () => {
  installFetchMock({ approximate: [nominatimCandidate()], awesome: awesomeResult() });
  const { geocodeDeliveryAddress } = await loadAddressModule("close-approximate-services");
  const location = await geocodeDeliveryAddress(CABUCU);
  assert.equal(location.source, "awesomeapi_cep");
  assert.equal(location.precision, "approximate");
  assert.ok(location.agreementDistanceKm < 1);
  assert.equal(isTrustedDeliveryLocation(location), false);
});

test("CASO 11: fontes aproximadas divergentes não decidem entrega", async () => {
  installFetchMock({
    approximate: [nominatimCandidate({ latitude: -22.944, longitude: -43.582 })],
    awesome: awesomeResult({ latitude: -22.88, longitude: -43.65 }),
  });
  const { geocodeDeliveryAddress } = await loadAddressModule("ambiguous-services");
  await assert.rejects(
    geocodeDeliveryAddress(CABUCU),
    (error) => error.code === "ADDRESS_AMBIGUOUS" && error.precision === "ambiguous" && error.differenceKm > 1,
  );
});

test("CASO 12: retirada no local ignora localização", () => {
  const assessment = evaluateOrderDelivery("retirada", null, RANGES, SETTINGS);
  assert.deepEqual(assessment, { allowed: true, fee: 0, code: "PICKUP", message: "Retirada no local." });
});

test("CACHE: approximate não impede nova tentativa exata do mesmo número", async () => {
  let exactCandidates = [];
  installFetchMock({ exact: () => exactCandidates, approximate: [nominatimCandidate()], awesome: awesomeResult() });
  const { geocodeDeliveryAddress } = await loadAddressModule("approximate-cache");
  const first = await geocodeDeliveryAddress(CABUCU);
  assert.equal(first.precision, "approximate");
  exactCandidates = [nominatimCandidate({ houseNumber: CABUCU.number })];
  const second = await geocodeDeliveryAddress(CABUCU);
  assert.equal(second.source, "nominatim_exact");
});
