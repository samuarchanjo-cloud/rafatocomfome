import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluateOrderDelivery } from "../src/lib/delivery.js";
import { parseGoogleGeocodingResult } from "../src/lib/geocodingProvider.js";
import { isTrustedDeliveryLocation } from "../src/lib/location.js";
import {
  createMapPinLocation,
  latLngToWorld,
  MAX_MAP_PIN_OFFSET_KM,
  worldToLatLng,
} from "../src/lib/mapLocation.js";

const STORE = { latitude: -22.943800658459434, longitude: -43.582438704219854 };
const SETTINGS = { maximum_delivery_distance_km: 3.5, below_one_km_behavior: "fixed", below_one_km_fee: 3 };
const RANGES = [{ min_distance_km: 1, max_distance_km: 3.5, fee: 5, active: true }];
const ADDRESS = {
  postalCode: "23036-050",
  street: "Rua Giordano Vincenzo",
  number: "515",
  neighborhood: "Guaratiba",
  city: "Rio de Janeiro",
  state: "RJ",
};

function googleComponent(longName, shortName, type) {
  return { long_name: longName, short_name: shortName || longName, types: [type] };
}

function googleResult({ locationType = "ROOFTOP", number = ADDRESS.number } = {}) {
  return {
    formatted_address: "Rua Giordano Vincenzo, 515 - Guaratiba, Rio de Janeiro - RJ, 23036-050",
    geometry: {
      location_type: locationType,
      location: { lat: () => -22.9380217, lng: () => -43.582416 },
    },
    address_components: [
      googleComponent(number, number, "street_number"),
      googleComponent(ADDRESS.street, ADDRESS.street, "route"),
      googleComponent(ADDRESS.city, ADDRESS.city, "locality"),
      googleComponent("Rio de Janeiro", "RJ", "administrative_area_level_1"),
      googleComponent(ADDRESS.postalCode, ADDRESS.postalCode, "postal_code"),
    ],
  };
}

function locationAtDistance(km) {
  return { latitude: STORE.latitude + (km / 111.195), longitude: STORE.longitude };
}

test("Google ROOFTOP com número e CEP completos é endereço exato", () => {
  const location = parseGoogleGeocodingResult(googleResult(), ADDRESS);
  assert.equal(location.source, "google_exact");
  assert.equal(location.precision, "exact");
  assert.equal(isTrustedDeliveryLocation(location), true);
});

test("Google sem número exato vira somente candidato para o mapa", () => {
  const location = parseGoogleGeocodingResult(googleResult({ locationType: "GEOMETRIC_CENTER", number: "" }), ADDRESS);
  assert.equal(location.source, "google_approximate");
  assert.equal(location.precision, "approximate");
  assert.equal(location.requiresMap, true);
  assert.equal(isTrustedDeliveryLocation(location), false);
});

test("reposicionar e confirmar o PIN cria uma localização confiável sem GPS", () => {
  const reference = locationAtDistance(0.64);
  const pin = { latitude: reference.latitude + 0.0004, longitude: reference.longitude - 0.0003 };
  const location = createMapPinLocation(pin, reference);
  assert.equal(location.source, "map_pin");
  assert.equal(location.precision, "exact");
  assert.equal(isTrustedDeliveryLocation(location), true);
  assert.ok(location.referenceDistanceKm < 0.1);
  assert.equal("accuracy" in location, false);
});

test("cliente fisicamente longe pode confirmar o destino no mapa", () => {
  const destination = locationAtDistance(0.6);
  const location = createMapPinLocation(destination, destination);
  const assessment = evaluateOrderDelivery("entrega", { ...location, km: 0.6 }, RANGES, SETTINGS);
  assert.equal(location.source, "map_pin");
  assert.equal(assessment.allowed, true);
  assert.equal(assessment.fee, 3);
});

test("PIN histórico acima de 3,5 km não libera entrega própria", () => {
  const destination = locationAtDistance(4);
  const location = createMapPinLocation(destination, destination);
  const assessment = evaluateOrderDelivery("entrega", { ...location, km: 4 }, RANGES, SETTINGS);
  assert.equal(assessment.allowed, false);
  assert.equal(assessment.code, "UBER_AVAILABLE");
  assert.equal(assessment.uberAvailable, true);
  assert.equal(assessment.message, "Este endereço fica fora da nossa área de entrega própria.");
});

test("PIN grosseiramente distante da região do endereço é rejeitado", () => {
  assert.equal(MAX_MAP_PIN_OFFSET_KM, 10);
  assert.throws(
    () => createMapPinLocation(locationAtDistance(12), STORE),
    (error) => error.code === "MAP_PIN_OUTSIDE_ADDRESS_REGION",
  );
});

test("projeção do mapa preserva a coordenada ao mover e reposicionar", () => {
  const original = { latitude: -22.9380217, longitude: -43.582416 };
  const world = latLngToWorld(original, 17);
  const moved = worldToLatLng({ x: world.x + 120, y: world.y - 80 }, 17);
  const returned = worldToLatLng(latLngToWorld(moved, 17), 17);
  assert.ok(Math.abs(moved.latitude - returned.latitude) < 1e-9);
  assert.ok(Math.abs(moved.longitude - returned.longitude) < 1e-9);
});

test("CEPs de regressão podem usar confirmação por PIN na região encontrada", () => {
  for (const postalCode of ["23036-061", "23036-076", "23036-060", "23036-050"]) {
    const reference = locationAtDistance(0.8);
    const location = createMapPinLocation({ ...reference }, reference);
    assert.equal(location.source, "map_pin", postalCode);
  }
});

test("checkout usa GPS somente após confirmação explícita e preserva pagamentos e Pix", async () => {
  const [app, mapPicker, styles] = await Promise.all([
    readFile(new URL("../src/App.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/MapLocationPicker.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(app, /MapLocationPicker/);
  assert.match(app, /requestDeviceGps\(\{ confirmed: true \}\)/);
  assert.match(app, /Você está no local da entrega\?/);
  assert.match(app, /Não, estou em outro lugar/);
  assert.match(mapPicker, /Confirmar este local/);
  assert.match(mapPicker, /Voltar e revisar endereço/);
  assert.match(mapPicker, /Usar minha localização atual/);
  for (const payment of ["pix", "dinheiro", "credito", "debito"]) assert.match(app, new RegExp(`checkout\\.payment === "${payment}"`));
  assert.match(app, /navigator\.clipboard\.writeText\(store\.settings\.pix_key\)/);
  assert.match(app, /setPixCopyStatus\("Chave Pix copiada"\)/);
  assert.match(app, /showQrCode && <div className="pix-qr-frame">/);
  assert.match(app, /onError=\{\(\) => setShowQrCode\(false\)\}/);
  assert.match(styles, /width: clamp\(160px, 48vw, 190px\)/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /touch-action: none/);
});
