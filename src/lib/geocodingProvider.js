import { composeDeliveryAddress, geocodeDeliveryAddress, postalCodeDigits } from "./address.js";

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeStreet(value) {
  return normalizeText(value).replace(/^(rua|r|avenida|av|estrada|rodovia|travessa|tv|praca|largo|alameda)\s+/, "");
}

function compatibleStreet(expected, actual) {
  const first = normalizeStreet(expected);
  const second = normalizeStreet(actual);
  return Boolean(first && second && (first === second || first.includes(second) || second.includes(first)));
}

function component(result, type, short = false) {
  const item = result?.address_components?.find((candidate) => candidate.types?.includes(type));
  return short ? item?.short_name : item?.long_name;
}

export function parseGoogleGeocodingResult(result, address) {
  const latitude = Number(result?.geometry?.location?.lat?.());
  const longitude = Number(result?.geometry?.location?.lng?.());
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const street = component(result, "route") || "";
  const number = component(result, "street_number") || "";
  const postalCode = component(result, "postal_code") || "";
  const city = component(result, "locality") || component(result, "administrative_area_level_2") || "";
  const state = component(result, "administrative_area_level_1", true) || "";
  const cityAndStateCompatible = normalizeText(city) === normalizeText(address.city) && normalizeText(state) === normalizeText(address.state);
  if (!cityAndStateCompatible) return null;

  const fullPostalCodeCompatible = postalCodeDigits(postalCode) === postalCodeDigits(address.postalCode);
  const streetCompatible = compatibleStreet(address.street, street);
  const exact = (
    result.geometry.location_type === "ROOFTOP" &&
    normalizeText(number) === normalizeText(address.number) &&
    streetCompatible &&
    fullPostalCodeCompatible
  );

  return {
    latitude,
    longitude,
    displayName: result.formatted_address || composeDeliveryAddress(address),
    precision: exact ? "exact" : "approximate",
    source: exact ? "google_exact" : "google_approximate",
    postalCode,
    type: result.geometry.location_type || null,
    addresstype: exact ? "street_address" : "geocode",
    requiresMap: !exact,
    compatible: streetCompatible && fullPostalCodeCompatible,
  };
}

export function configuredGeocodingProvider() {
  return "nominatim_exact";
}

export function mapCandidateFromError(error) {
  if (error?.mapCandidate) return error.mapCandidate;
  const sources = Array.isArray(error?.sources) ? error.sources : [];
  return sources.find((source) => source.source === "awesomeapi_cep") || sources[0] || null;
}

export async function locateDeliveryAddress(address, {
  signal,
  postalAddress,
  origin,
  maximumCandidateDistanceKm,
} = {}) {
  return geocodeDeliveryAddress(address, { signal, postalAddress, origin, maximumCandidateDistanceKm });
}
