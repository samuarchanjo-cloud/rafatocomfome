import assert from "node:assert/strict";
import test from "node:test";

import { evaluateDelivery } from "../src/lib/delivery.js";

const ADDRESS = {
  postalCode: "23036-060",
  street: "Estrada Cabuçu de Baixo",
  number: "388",
  neighborhood: "Guaratiba",
  city: "Rio de Janeiro",
  state: "RJ",
};

const SETTINGS = {
  maximum_delivery_distance_km: 3.5,
  below_one_km_behavior: "fixed",
  below_one_km_fee: 3,
};

const RANGES = [{ min_distance_km: 1, max_distance_km: 3.5, fee: 5, active: true }];

function response(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

function viaCep(address = ADDRESS) {
  return {
    cep: address.postalCode,
    logradouro: address.street,
    bairro: address.neighborhood,
    localidade: address.city,
    uf: address.state,
  };
}

function nominatimCandidate({
  address = ADDRESS,
  latitude = -22.944,
  longitude = -43.582,
  houseNumber,
  postalCode = address.postalCode,
  type = houseNumber ? "house" : "residential",
  addresstype = houseNumber ? "house" : "road",
  category = houseNumber ? "place" : "highway",
  placeRank = houseNumber ? 30 : 26,
} = {}) {
  return {
    lat: String(latitude),
    lon: String(longitude),
    type,
    addresstype,
    category,
    place_rank: placeRank,
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

function awesomeResult({
  address = ADDRESS,
  latitude = -22.9441,
  longitude = -43.5821,
} = {}) {
  return {
    cep: address.postalCode.replace(/\D/g, ""),
    address: address.street,
    district: address.neighborhood,
    city: address.city,
    state: address.state,
    address_type: "Estrada",
    lat: String(latitude),
    lng: String(longitude),
  };
}

async function loadAddressModule(name) {
  return import(`../src/lib/address.js?test=${name}-${Date.now()}-${Math.random()}`);
}

function installFetchMock({ exact = [], approximate = [], awesome = null, exactError = null }) {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.hostname === "viacep.com.br") return response(viaCep());
    if (url.hostname === "nominatim.openstreetmap.org") {
      const query = url.searchParams.get("q") || "";
      if (query.includes(`, ${ADDRESS.number},`)) {
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

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
let clock = 1_800_000_000_000;
Date.now = () => {
  clock += 1_001;
  return clock;
};

test.after(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
});

test("A) número exato localizado usa Nominatim exato", async () => {
  const exactCandidate = nominatimCandidate({ houseNumber: ADDRESS.number });
  const calls = installFetchMock({ exact: [exactCandidate] });
  const { geocodeDeliveryAddress } = await loadAddressModule("exact");

  const result = await geocodeDeliveryAddress(ADDRESS);

  assert.equal(result.precision, "exact");
  assert.equal(result.source, "nominatim_exact");
  assert.equal(result.addresstype, "house");
  assert.equal(calls.some((url) => url.includes("awesomeapi")), false);
});

test("B) road com CEP apenas parcialmente compatível não é residência precisa", async () => {
  const partialRoad = nominatimCandidate({ postalCode: "23036-053" });
  installFetchMock({ exact: [partialRoad], approximate: [partialRoad] });
  const { geocodeDeliveryAddress } = await loadAddressModule("partial-postcode");

  await assert.rejects(() => geocodeDeliveryAddress(ADDRESS), { code: "ADDRESS_NOT_PRECISE" });
});

test("C) Nominatim e AwesomeAPI próximos priorizam o CEP completo da AwesomeAPI", async () => {
  const road = nominatimCandidate({ latitude: -22.944, longitude: -43.582 });
  const postal = awesomeResult({ latitude: -22.9442, longitude: -43.5821 });
  installFetchMock({ approximate: [road], awesome: postal });
  const { geocodeDeliveryAddress } = await loadAddressModule("agreeing-sources");

  const result = await geocodeDeliveryAddress(ADDRESS);

  assert.equal(result.precision, "approximate");
  assert.equal(result.source, "awesomeapi_cep");
  assert.ok(result.agreementDistanceKm < 1);
});

test("D) fontes significativamente divergentes produzem endereço ambíguo", async () => {
  const road = nominatimCandidate({ latitude: -22.944, longitude: -43.582 });
  const postal = awesomeResult({ latitude: -22.88, longitude: -43.65 });
  installFetchMock({ approximate: [road], awesome: postal });
  const { geocodeDeliveryAddress } = await loadAddressModule("divergent-sources");

  await assert.rejects(
    () => geocodeDeliveryAddress(ADDRESS),
    (error) => error.code === "ADDRESS_AMBIGUOUS" && error.precision === "ambiguous" && error.differenceKm > 1,
  );
});

test("E) resultado aproximado acima do limite não vira OUTSIDE_AREA", () => {
  const assessment = evaluateDelivery(7, RANGES, SETTINGS, "approximate");

  assert.equal(assessment.allowed, false);
  assert.equal(assessment.code, "ADDRESS_NOT_PRECISE");
});

test("F) endereço exato acima de 3,5 km continua bloqueado", () => {
  const assessment = evaluateDelivery(7, RANGES, SETTINGS, "exact");

  assert.equal(assessment.allowed, false);
  assert.equal(assessment.code, "OUTSIDE_AREA");
});

test("G) endereço exato dentro da área mantém a taxa configurada", () => {
  const assessment = evaluateDelivery(2, RANGES, SETTINGS, "exact");

  assert.equal(assessment.allowed, true);
  assert.equal(assessment.fee, 5);
  assert.equal(assessment.code, "RANGE");
});

test("H) cache aproximado não impede uma nova tentativa exata", async () => {
  let exactCandidates = [];
  const road = nominatimCandidate();
  installFetchMock({
    exact: () => exactCandidates,
    approximate: [road],
    awesome: awesomeResult(),
  });
  const { geocodeDeliveryAddress } = await loadAddressModule("approximate-cache");

  const first = await geocodeDeliveryAddress(ADDRESS);
  assert.equal(first.precision, "approximate");

  exactCandidates = [nominatimCandidate({ houseNumber: ADDRESS.number, latitude: -22.9439, longitude: -43.5822 })];
  const second = await geocodeDeliveryAddress(ADDRESS);

  assert.equal(second.precision, "exact");
  assert.equal(second.source, "nominatim_exact");
});

test("I) indisponibilidade do Nominatim ainda permite fallback seguro por CEP", async () => {
  installFetchMock({ exactError: new TypeError("network timeout"), awesome: awesomeResult() });
  const { geocodeDeliveryAddress } = await loadAddressModule("nominatim-timeout");

  const result = await geocodeDeliveryAddress(ADDRESS);

  assert.equal(result.precision, "approximate");
  assert.equal(result.source, "awesomeapi_cep");
});
