import assert from "node:assert/strict";
import test from "node:test";

import { distanceInKm, effectiveDeliveryDistance, evaluateOrderDelivery } from "../src/lib/delivery.js";
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
  postalCode: "23036-061", street: "Rua Lolita Rodrigues", number: "1",
  neighborhood: "Guaratiba", city: "Rio de Janeiro", state: "RJ",
};
const WALDIR = {
  postalCode: "23036-076", street: "Rua Waldir José de Melo", number: "1",
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
  houseNumber,
  postalCode = address.postalCode,
  type = houseNumber ? "house" : "residential",
  addresstype = houseNumber ? "house" : "road",
  category = houseNumber ? "place" : "highway",
  placeRank = houseNumber ? 30 : 26,
  boundingBox = [latitude - 0.001, latitude + 0.001, longitude - 0.001, longitude + 0.001],
} = {}) {
  return {
    lat: String(latitude),
    lon: String(longitude),
    type,
    addresstype,
    category,
    place_rank: placeRank,
    boundingbox: boundingBox.map(String),
    display_name: `${address.street}, ${address.city}, ${postalCode}`,
    address: {
      ...(houseNumber ? { house_number: String(houseNumber) } : {}),
      road: address.street,
      suburb: address.neighborhood,
      city: address.city,
      state: "Rio de Janeiro",
      "ISO3166-2-lvl4": "BR-RJ",
      postcode: postalCode,
      country_code: "br",
    },
  };
}

function awesomeResult({ address = CABUCU, latitude = -22.9441, longitude = -43.5821 } = {}) {
  return {
    cep: address.postalCode.replace(/\D/g, ""),
    address: address.street,
    district: address.neighborhood,
    city: address.city,
    state: address.state,
    address_type: "Rua",
    lat: String(latitude),
    lng: String(longitude),
  };
}

async function loadAddressModule(name) {
  return import(`../src/lib/address.js?test=${name}-${Date.now()}-${Math.random()}`);
}

function installFetchMock({
  address = CABUCU,
  viaCepAddress = address,
  exact = [],
  approximate = [],
  awesome = null,
  exactError = null,
}) {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.hostname === "viacep.com.br") return response(viaCep(viaCepAddress));
    if (url.hostname === "nominatim.openstreetmap.org") {
      const street = url.searchParams.get("street") || "";
      if (street.startsWith(`${address.number} `)) {
        if (exactError) throw exactError;
        return response(typeof exact === "function" ? exact() : exact);
      }
      return response(typeof approximate === "function" ? approximate() : approximate);
    }
    if (url.hostname === "cep.awesomeapi.com.br") {
      return awesome
        ? response(typeof awesome === "function" ? awesome() : awesome)
        : response({}, { ok: false, status: 404 });
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
  const centerKm = distanceInKm(STORE, location);
  const km = effectiveDeliveryDistance(centerKm, location);
  const assessment = evaluateOrderDelivery("entrega", { ...location, centerKm, km }, RANGES, SETTINGS);
  return { centerKm, km, assessment };
}

async function geocodeConsensusAt(km, address = CABUCU, extra = {}) {
  const latitude = STORE.latitude + (km / 111.195);
  installFetchMock({
    address,
    approximate: [nominatimCandidate({ address, latitude, longitude: STORE.longitude, ...extra })],
    awesome: awesomeResult({ address, latitude, longitude: STORE.longitude }),
  });
  const { geocodeDeliveryAddress } = await loadAddressModule(`consensus-${km}-${address.postalCode}`);
  return geocodeDeliveryAddress(address, { storeCoordinates: STORE });
}

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
let clock = 1_800_000_000_000;
Date.now = () => { clock += 1_001; return clock; };
test.after(() => { globalThis.fetch = originalFetch; Date.now = originalDateNow; });

test("A: número exato localizado a 0,6 km usa a localização exata normalmente", async () => {
  const latitude = STORE.latitude + (0.6 / 111.195);
  installFetchMock({
    address: GIORDANO,
    exact: [nominatimCandidate({
      address: GIORDANO,
      houseNumber: GIORDANO.number,
      latitude,
      longitude: STORE.longitude,
    })],
  });
  const { geocodeDeliveryAddress } = await loadAddressModule("giordano-exact-inside");
  const location = await geocodeDeliveryAddress(GIORDANO, { storeCoordinates: STORE });
  const { centerKm, assessment } = assessLocation(location);
  assert.equal(location.source, "nominatim_exact");
  assert.equal(location.precision, "exact");
  assert.equal(isTrustedDeliveryLocation(location), true);
  assert.ok(centerKm > 0.59 && centerKm < 0.61);
  assert.equal(assessment.allowed, true);
  assert.equal(assessment.fee, 3);
});

test("B: endereço exato a 4 km continua fora da área", async () => {
  const latitude = STORE.latitude + (4 / 111.195);
  installFetchMock({ exact: [nominatimCandidate({
    houseNumber: CABUCU.number,
    latitude,
    longitude: STORE.longitude,
  })] });
  const { geocodeDeliveryAddress } = await loadAddressModule("exact-outside");
  const location = await geocodeDeliveryAddress(CABUCU, { storeCoordinates: STORE });
  const { assessment } = assessLocation(location);
  assert.equal(assessment.allowed, false);
  assert.equal(assessment.code, "OUTSIDE_AREA");
});

test("C: consenso a 0,06 km soma margem e mantém taxa abaixo de 1 km", async () => {
  const location = await geocodeConsensusAt(0.06);
  const { centerKm, km, assessment } = assessLocation(location);
  assert.equal(location.source, "address_consensus");
  assert.equal(location.precision, "consensus");
  assert.equal(location.uncertainty, MIN_ADDRESS_UNCERTAINTY_M);
  assert.ok(centerKm > 0.05 && centerKm < 0.07);
  assert.equal(km, 0.81);
  assert.equal(assessment.allowed, true);
  assert.equal(assessment.fee, 3);
});

test("D: consenso a 0,64 km usa 1,39 km efetivos e a faixa correspondente", async () => {
  const location = await geocodeConsensusAt(0.64);
  const { km, assessment } = assessLocation(location);
  assert.ok(Math.abs(km - 1.39) < Number.EPSILON * 4);
  assert.equal(assessment.allowed, true);
  assert.equal(assessment.fee, 5);
});

test("E: consenso a 2 km permanece dentro da área com margem conservadora", async () => {
  const location = await geocodeConsensusAt(2);
  const { km, assessment } = assessLocation(location);
  assert.equal(km, 2.75);
  assert.equal(assessment.allowed, true);
  assert.equal(assessment.fee, 5);
});

test("F: consenso a 3 km exige confirmação porque a distância efetiva passa de 3,5 km", async () => {
  const location = await geocodeConsensusAt(3);
  const { km, assessment } = assessLocation(location);
  assert.equal(km, 3.75);
  assert.equal(assessment.allowed, false);
  assert.equal(assessment.code, "ADDRESS_REQUIRES_CONFIRMATION");
});

test("G: consenso aparentemente a 5 km não vira bloqueio definitivo de área", async () => {
  const location = await geocodeConsensusAt(5);
  const { assessment } = assessLocation(location);
  assert.equal(assessment.allowed, false);
  assert.equal(assessment.code, "ADDRESS_REQUIRES_CONFIRMATION");
  assert.notEqual(assessment.code, "OUTSIDE_AREA");
});

test("H: GPS confirmado a 0,6 km é aceito sem margem de endereço", () => {
  const location = coordinatesAtDistance(0.6);
  const { centerKm, km, assessment } = assessLocation(location);
  assert.equal(location.source, "device_gps");
  assert.equal(isTrustedDeliveryLocation(location), true);
  assert.equal(km, Math.round(centerKm * 100) / 100);
  assert.equal(assessment.allowed, true);
  assert.equal(assessment.fee, 3);
});

test("I: GPS confirmado a 5 km continua fora da área", () => {
  const { assessment } = assessLocation(coordinatesAtDistance(5));
  assert.equal(assessment.allowed, false);
  assert.equal(assessment.code, "OUTSIDE_AREA");
});

test("J: fontes de CEP significativamente divergentes produzem resultado ambíguo", async () => {
  installFetchMock({
    approximate: [nominatimCandidate({ latitude: -22.944, longitude: -43.582 })],
    awesome: awesomeResult({ latitude: -22.88, longitude: -43.65 }),
  });
  const { geocodeDeliveryAddress } = await loadAddressModule("ambiguous-services");
  await assert.rejects(
    geocodeDeliveryAddress(CABUCU, { storeCoordinates: STORE }),
    (error) => error.code === "ADDRESS_AMBIGUOUS" && error.precision === "ambiguous" && error.differenceKm > 1,
  );
});

test("K: CEP parcial do Nominatim não forma consenso sem uma fonte de CEP completo", async () => {
  installFetchMock({ approximate: [nominatimCandidate({ postalCode: "23036" })], awesome: null });
  const { geocodeDeliveryAddress } = await loadAddressModule("partial-postcode");
  await assert.rejects(
    geocodeDeliveryAddress(CABUCU, { storeCoordinates: STORE }),
    (error) => error.code === "ADDRESS_NOT_PRECISE",
  );
});

test("L: endereço incompatível com o ViaCEP continua rejeitado", async () => {
  installFetchMock({
    viaCepAddress: { ...CABUCU, street: "Rua Incompatível" },
    awesome: awesomeResult(),
  });
  const { geocodeDeliveryAddress } = await loadAddressModule("viacep-mismatch");
  await assert.rejects(
    geocodeDeliveryAddress(CABUCU, { storeCoordinates: STORE }),
    (error) => error.code === "ADDRESS_POSTAL_CODE_MISMATCH",
  );
});

test("M: consenso seguro permite pedido remoto sem consultar GPS", async () => {
  const location = await geocodeConsensusAt(2, GIORDANO);
  const { assessment } = assessLocation(location);
  assert.equal(location.source, "address_consensus");
  assert.equal(isTrustedDeliveryLocation(location), true);
  assert.equal(assessment.allowed, true);
});

test("N: retirada no local continua sem exigir localização", () => {
  const assessment = evaluateOrderDelivery("retirada", null, RANGES, SETTINGS);
  assert.deepEqual(assessment, {
    allowed: true,
    fee: 0,
    code: "PICKUP",
    message: "Retirada no local.",
  });
});

test("timeout do Nominatim ainda permite consenso conservador pelo CEP completo", async () => {
  installFetchMock({ exactError: new TypeError("network timeout"), awesome: awesomeResult() });
  const { geocodeDeliveryAddress } = await loadAddressModule("nominatim-timeout");
  const location = await geocodeDeliveryAddress(CABUCU, { storeCoordinates: STORE });
  assert.equal(location.source, "address_consensus");
  assert.equal(location.precision, "consensus");
  assert.equal(location.uncertainty, MIN_ADDRESS_UNCERTAINTY_M);
  assert.equal(isTrustedDeliveryLocation(location), true);
});

test("bounding box do Nominatim aumenta conservadoramente a incerteza", async () => {
  const latitude = STORE.latitude + (0.2 / 111.195);
  const location = await geocodeConsensusAt(0.2, CABUCU, {
    boundingBox: [latitude - 0.01, latitude + 0.01, STORE.longitude - 0.01, STORE.longitude + 0.01],
  });
  assert.ok(location.uncertainty > MIN_ADDRESS_UNCERTAINTY_M);
});

test("GPS exige confirmação, precisão de até 150 m e opções de alta precisão", async () => {
  assert.equal(MAX_DEVICE_GPS_ACCURACY_M, 150);
  assert.throws(() => coordinatesAtDistance(0.6, 200), (error) => error.code === "GPS_INACCURATE");

  let receivedOptions;
  const geolocation = {
    getCurrentPosition(_success, error, options) {
      receivedOptions = options;
      error({ code: 1 });
    },
  };
  await assert.rejects(
    requestDeviceGps({ confirmed: true, geolocation }),
    (error) => error.code === "GPS_PERMISSION_DENIED",
  );
  assert.deepEqual(receivedOptions, DEVICE_GPS_OPTIONS);

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

test("CACHE: consenso não impede uma nova tentativa exata para o mesmo número", async () => {
  let exactCandidates = [];
  installFetchMock({
    exact: () => exactCandidates,
    approximate: [nominatimCandidate()],
    awesome: awesomeResult(),
  });
  const { geocodeDeliveryAddress } = await loadAddressModule("consensus-cache");
  const first = await geocodeDeliveryAddress(CABUCU, { storeCoordinates: STORE });
  assert.equal(first.precision, "consensus");
  exactCandidates = [nominatimCandidate({ houseNumber: CABUCU.number })];
  const second = await geocodeDeliveryAddress(CABUCU, { storeCoordinates: STORE });
  assert.equal(second.source, "nominatim_exact");
});

test("Nominatim usa busca estruturada, CEP completo, viewbox local e bounded nos quatro CEPs", async () => {
  for (const address of [LOLITA, WALDIR, CABUCU, GIORDANO]) {
    const calls = installFetchMock({ address, awesome: awesomeResult({ address }) });
    const { geocodeDeliveryAddress } = await loadAddressModule(`structured-${address.postalCode}`);
    await geocodeDeliveryAddress(address, { storeCoordinates: STORE });
    const nominatimCalls = calls.filter((value) => new URL(value).hostname === "nominatim.openstreetmap.org");
    assert.equal(nominatimCalls.length, 2, address.postalCode);
    for (const [index, value] of nominatimCalls.entries()) {
      const url = new URL(value);
      assert.equal(url.searchParams.has("q"), false);
      assert.equal(url.searchParams.get("city"), address.city);
      assert.equal(url.searchParams.get("state"), address.state);
      assert.equal(url.searchParams.get("postalcode"), address.postalCode);
      assert.equal(url.searchParams.get("countrycodes"), "br");
      assert.equal(url.searchParams.get("bounded"), "1");
      assert.equal(url.searchParams.get("viewbox")?.split(",").length, 4);
      assert.equal(url.searchParams.get("street"), index === 0 ? `${address.number} ${address.street}` : address.street);
    }
  }
});

test("candidato devolvido fora do raio local de 5 km é descartado defensivamente", async () => {
  const farLatitude = STORE.latitude + (8 / 111.195);
  installFetchMock({
    exact: [nominatimCandidate({
      houseNumber: CABUCU.number,
      latitude: farLatitude,
      longitude: STORE.longitude,
    })],
    approximate: [],
    awesome: null,
  });
  const { geocodeDeliveryAddress } = await loadAddressModule("outside-local-radius");
  await assert.rejects(
    geocodeDeliveryAddress(CABUCU, { storeCoordinates: STORE }),
    (error) => error.code === "ADDRESS_NOT_PRECISE",
  );
});

test("viewbox de 5 km é derivada da coordenada da loja, sem coordenadas extras fixas", async () => {
  const { buildLocalNominatimViewbox, NOMINATIM_LOCAL_SEARCH_RADIUS_KM } = await loadAddressModule("viewbox");
  assert.equal(NOMINATIM_LOCAL_SEARCH_RADIUS_KM, 5);
  const [left, top, right, bottom] = buildLocalNominatimViewbox(STORE).split(",").map(Number);
  assert.ok(left < STORE.longitude && right > STORE.longitude);
  assert.ok(bottom < STORE.latitude && top > STORE.latitude);
  assert.ok(Math.abs((left + right) / 2 - STORE.longitude) < 1e-12);
  assert.ok(Math.abs((top + bottom) / 2 - STORE.latitude) < 1e-12);
});
