import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { distanceInKm, effectiveDeliveryDistance, evaluateOrderDelivery } from "../src/lib/delivery.js";
import { locateDeliveryAddress } from "../src/lib/geocodingProvider.js";
import { createPostalZoneLocation } from "../src/lib/postalZone.js";
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
const NORMAL_155 = {
  postalCode: "23036-155", street: "Rua Alfredo Britto", number: "80",
  neighborhood: "Campo Grande", city: "Rio de Janeiro", state: "RJ",
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
      return response(typeof candidates === "function" ? candidates(url) : candidates);
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

test("endereço residencial preciso acima de 3,5 km oferece Uber Entrega", async () => {
  const latitude = STORE.latitude + (4 / 111.195);
  installFetchMock({ candidates: [nominatimCandidate({ latitude, longitude: STORE.longitude })] });
  const { geocodeDeliveryAddress } = await loadAddressModule("exact-outside");
  const location = await geocodeDeliveryAddress(CABUCU);
  const { assessment } = assessLocation(location);
  assert.equal(assessment.allowed, false);
  assert.equal(assessment.code, "UBER_AVAILABLE");
  assert.equal(assessment.uberAvailable, true);
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

test("endereço sem house_number usa fallback da rua e não aciona AwesomeAPI", async () => {
  const calls = installFetchMock({ candidates: [nominatimCandidate({ houseNumber: null })] });
  const { geocodeDeliveryAddress } = await loadAddressModule("road-only");
  const location = await geocodeDeliveryAddress(CABUCU);
  assert.equal(location.source, "nominatim_street");
  assert.equal(location.precision, "street");
  assert.equal(isTrustedDeliveryLocation(location), true);
  assert.equal(calls.filter((value) => new URL(value).hostname === "nominatim.openstreetmap.org").length, 2);
  assert.equal(calls.some((value) => new URL(value).hostname === "cep.awesomeapi.com.br"), false);
});

test("CEP 23036-155 sem exceção usa fallback de rua e calcula Haversine", async () => {
  const latitude = STORE.latitude + (2 / 111.195);
  const calls = installFetchMock({
    address: NORMAL_155,
    candidates: (url) => url.searchParams.get("q").includes(", 80,")
      ? []
      : [nominatimCandidate({
        address: NORMAL_155,
        houseNumber: null,
        postalCode: "23036-053",
        latitude,
        longitude: STORE.longitude,
      })],
  });
  const { geocodeDeliveryAddress } = await loadAddressModule("normal-23036-155");
  const location = await geocodeDeliveryAddress(NORMAL_155);
  const { centerKm, assessment } = assessLocation(location);

  assert.equal(location.source, "nominatim_street");
  assert.equal(location.postalCode, "23036-155");
  assert.ok(centerKm > 1.99 && centerKm < 2.01);
  assert.equal(assessment.allowed, true);
  assert.equal(assessment.fee, 5);
  const nominatimCalls = calls.filter((value) => new URL(value).hostname === "nominatim.openstreetmap.org");
  assert.equal(nominatimCalls.length, 2);
  const streetQuery = new URL(nominatimCalls[1]).searchParams.get("q");
  assert.doesNotMatch(streetQuery, /, 80,/);
  assert.doesNotMatch(streetQuery, /23036-155/);
});

test("CEP normal com fallback de rua acima de 3,5 km não usa entrega própria", async () => {
  const latitude = STORE.latitude + (4 / 111.195);
  installFetchMock({
    address: NORMAL_155,
    candidates: (url) => url.searchParams.get("q").includes(", 80,")
      ? []
      : [nominatimCandidate({ address: NORMAL_155, houseNumber: null, latitude, longitude: STORE.longitude })],
  });
  const { geocodeDeliveryAddress } = await loadAddressModule("normal-outside");
  const location = await geocodeDeliveryAddress(NORMAL_155);
  const { assessment } = assessLocation(location);
  assert.equal(assessment.allowed, false);
  assert.equal(assessment.code, "UBER_AVAILABLE");
  assert.equal(assessment.uberAvailable, true);
});

test("número residencial diferente sem resultado de rua continua sendo rejeitado", async () => {
  installFetchMock({ candidates: (url) => url.searchParams.get("q").includes(", 388,")
    ? [nominatimCandidate({ houseNumber: "999" })]
    : [] });
  const { geocodeDeliveryAddress } = await loadAddressModule("wrong-number");
  await assert.rejects(geocodeDeliveryAddress(CABUCU), (error) => error.code === "ADDRESS_NOT_PRECISE");
});

test("fallback de rua rejeita rua, cidade ou estado incompatíveis", async () => {
  const incompatibleCandidates = [
    nominatimCandidate({ road: "Rua Diferente" }),
    nominatimCandidate({ city: "Niterói" }),
    nominatimCandidate({ state: "São Paulo" }),
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

test("fallback de rua aceita postcode divergente, mas continua exigindo correspondência geográfica", async () => {
  const cases = [
    [LOLITA, nominatimCandidate({ address: LOLITA, houseNumber: null, postalCode: "23030-440", latitude: -22.9480261, longitude: -43.5844627 })],
    [CABUCU, nominatimCandidate({ houseNumber: null, postalCode: "23036-053", latitude: -22.940458, longitude: -43.5799353 })],
  ];

  for (const [address, candidate] of cases) {
    const calls = installFetchMock({
      address,
      candidates: (url) => url.searchParams.get("q").includes(`, ${address.number},`) ? [] : [candidate],
    });
    const { geocodeDeliveryAddress } = await loadAddressModule(`regression-${address.postalCode}`);
    const location = await geocodeDeliveryAddress(address);
    assert.equal(location.source, "nominatim_street");
    assert.equal(location.postalCode, address.postalCode);
    assert.equal(calls.filter((value) => new URL(value).hostname === "nominatim.openstreetmap.org").length, 2);
    assert.equal(calls.some((value) => new URL(value).hostname === "cep.awesomeapi.com.br"), false);
  }

  installFetchMock({ address: WALDIR, candidates: [] });
  const { geocodeDeliveryAddress } = await loadAddressModule("street-no-result");
  await assert.rejects(geocodeDeliveryAddress(WALDIR), (error) => error.code === "ADDRESS_NOT_PRECISE");
});

test("provedor automático prioriza a resolução exata do Nominatim", async () => {
  const calls = installFetchMock({ candidates: [nominatimCandidate()] });
  const location = await locateDeliveryAddress(CABUCU);
  assert.equal(location.source, "nominatim_exact");
  assert.deepEqual(
    [...new Set(calls.map((value) => new URL(value).hostname))],
    ["viacep.com.br", "nominatim.openstreetmap.org"],
  );
});

test("CEPs 23036-061 e 23036-076 com exceção exact validam ViaCEP e não chamam Nominatim", async () => {
  for (const address of [LOLITA, WALDIR]) {
    const calls = installFetchMock({ address, candidates: () => { throw new Error("Nominatim não deveria ser chamado"); } });
    const { validateDeliveryPostalAddress } = await loadAddressModule(`exact-zone-${address.postalCode}`);
    await validateDeliveryPostalAddress(address);
    const location = createPostalZoneLocation({
      id: `exact-${address.postalCode}`,
      deliveryFee: 3,
      matchType: "exact",
    }, address.postalCode);

    assert.equal(location.source, "postal_zone");
    assert.deepEqual(
      [...new Set(calls.map((value) => new URL(value).hostname))],
      ["viacep.com.br"],
    );
  }
});

test("checkout valida ViaCEP, consulta exceção exact e somente depois chama o geocoder", async () => {
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const validation = app.slice(app.indexOf("async function validateDeliveryAddress"), app.indexOf("function changeDeliveryLocation"));
  assert.match(validation, /validateDeliveryPostalAddress\(checkout/);
  assert.match(validation, /resolveDeliveryArea\(checkout\.postalCode, \{ signal:/);
  assert.match(validation, /createPostalZoneLocation\(zone, checkout\.postalCode\)/);
  assert.ok(validation.indexOf("resolveDeliveryArea") < validation.indexOf("locateDeliveryAddress"));
  assert.match(validation, /if \(administrativeLocation\)[\s\S]*return;/);
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
