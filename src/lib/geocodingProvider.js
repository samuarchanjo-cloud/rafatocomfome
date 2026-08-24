import { composeDeliveryAddress, geocodeDeliveryAddress, postalCodeDigits } from "./address.js";

const GOOGLE_MAPS_API_KEY = String(import.meta.env?.VITE_GOOGLE_MAPS_API_KEY || "").trim();
let googleMapsPromise = null;

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

function loadGoogleMaps(apiKey = GOOGLE_MAPS_API_KEY) {
  if (!apiKey || typeof document === "undefined") return Promise.resolve(null);
  if (globalThis.google?.maps?.Geocoder) return Promise.resolve(globalThis.google.maps);
  if (googleMapsPromise) return googleMapsPromise;

  googleMapsPromise = new Promise((resolve, reject) => {
    const callbackName = `__rafaGoogleMaps_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const cleanup = () => { delete globalThis[callbackName]; };
    globalThis[callbackName] = () => {
      cleanup();
      resolve(globalThis.google?.maps || null);
    };
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&callback=${callbackName}&loading=async&language=pt-BR&region=BR`;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      cleanup();
      googleMapsPromise = null;
      reject(new Error("Google Maps indisponível."));
    };
    document.head.append(script);
  });
  return googleMapsPromise;
}

async function geocodeWithGoogle(address, { signal, apiKey = GOOGLE_MAPS_API_KEY } = {}) {
  if (!apiKey) return null;
  const maps = await loadGoogleMaps(apiKey);
  if (!maps?.Geocoder || signal?.aborted) return null;

  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("A consulta foi cancelada.", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    new maps.Geocoder().geocode(
      { address: `${composeDeliveryAddress(address)}, Brasil`, region: "BR" },
      (results, status) => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) return;
        if (status !== "OK" || !Array.isArray(results)) {
          resolve(null);
          return;
        }
        const parsed = results.map((result) => parseGoogleGeocodingResult(result, address)).filter(Boolean);
        resolve(parsed.find((candidate) => candidate.precision === "exact") || parsed.find((candidate) => candidate.compatible) || null);
      },
    );
  });
}

export function configuredGeocodingProvider() {
  return GOOGLE_MAPS_API_KEY ? "google_maps+nominatim" : "nominatim+awesomeapi";
}

export function mapCandidateFromError(error) {
  if (error?.mapCandidate) return error.mapCandidate;
  const sources = Array.isArray(error?.sources) ? error.sources : [];
  return sources.find((source) => source.source === "awesomeapi_cep") || sources[0] || null;
}

export async function locateDeliveryAddress(address, { signal, storeCoordinates } = {}) {
  let googleCandidate = null;
  try {
    googleCandidate = await geocodeWithGoogle(address, { signal });
    if (googleCandidate?.precision === "exact") return googleCandidate;
  } catch (error) {
    if (error.name === "AbortError") throw error;
  }

  try {
    return await geocodeDeliveryAddress(address, { signal, storeCoordinates });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    if (googleCandidate) return googleCandidate;
    const mapCandidate = mapCandidateFromError(error);
    if (mapCandidate) error.mapCandidate = mapCandidate;
    throw error;
  }
}
