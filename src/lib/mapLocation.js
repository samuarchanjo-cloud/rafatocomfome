import { distanceInKm } from "./delivery.js";

export const MAP_PIN_DEFAULT_ZOOM = 17;
export const MAP_PIN_MIN_ZOOM = 15;
export const MAP_PIN_MAX_ZOOM = 19;
export const MAX_MAP_PIN_OFFSET_KM = 10;
export const MAP_TILE_SIZE = 256;

function mapPinError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function isValidCoordinatePair(location) {
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export function createMapPinLocation(pin, reference) {
  if (!isValidCoordinatePair(pin)) {
    throw mapPinError("MAP_PIN_INVALID", "O ponto selecionado no mapa é inválido. Tente novamente.");
  }
  if (!isValidCoordinatePair(reference)) {
    throw mapPinError("MAP_REFERENCE_REQUIRED", "Não foi possível relacionar o ponto ao endereço. Revise o endereço.");
  }

  const normalizedPin = { latitude: Number(pin.latitude), longitude: Number(pin.longitude) };
  const normalizedReference = {
    latitude: Number(reference.latitude),
    longitude: Number(reference.longitude),
  };
  const referenceDistanceKm = distanceInKm(normalizedReference, normalizedPin);
  if (referenceDistanceKm > MAX_MAP_PIN_OFFSET_KM) {
    throw mapPinError(
      "MAP_PIN_OUTSIDE_ADDRESS_REGION",
      "O ponto ficou muito distante da região do endereço. Revise o endereço ou ajuste o mapa.",
    );
  }

  return {
    ...normalizedPin,
    precision: "exact",
    source: "map_pin",
    referenceLatitude: normalizedReference.latitude,
    referenceLongitude: normalizedReference.longitude,
    referenceDistanceKm,
  };
}

function clampMapLatitude(latitude) {
  return Math.max(-85.05112878, Math.min(85.05112878, Number(latitude)));
}

function wrapLongitude(longitude) {
  return ((((Number(longitude) + 180) % 360) + 360) % 360) - 180;
}

export function latLngToWorld(location, zoom) {
  const latitude = clampMapLatitude(location.latitude);
  const longitude = wrapLongitude(location.longitude);
  const scale = MAP_TILE_SIZE * (2 ** zoom);
  const sinLatitude = Math.sin((latitude * Math.PI) / 180);
  return {
    x: ((longitude + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) * scale,
  };
}

export function worldToLatLng(point, zoom) {
  const scale = MAP_TILE_SIZE * (2 ** zoom);
  const wrappedX = ((point.x % scale) + scale) % scale;
  const y = Math.max(0, Math.min(scale, point.y));
  const longitude = (wrappedX / scale) * 360 - 180;
  const latitude = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / scale))) * 180) / Math.PI;
  return { latitude, longitude };
}
