const VIA_CEP_ENDPOINT = "https://viacep.com.br/ws";
const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_REQUEST_INTERVAL_MS = 1_000;

const postalCodeCache = new Map();
const geocodingCache = new Map();
let lastNominatimRequestAt = 0;

const BRAZILIAN_STATES = {
  AC: "Acre",
  AL: "Alagoas",
  AP: "Amapá",
  AM: "Amazonas",
  BA: "Bahia",
  CE: "Ceará",
  DF: "Distrito Federal",
  ES: "Espírito Santo",
  GO: "Goiás",
  MA: "Maranhão",
  MT: "Mato Grosso",
  MS: "Mato Grosso do Sul",
  MG: "Minas Gerais",
  PA: "Pará",
  PB: "Paraíba",
  PR: "Paraná",
  PE: "Pernambuco",
  PI: "Piauí",
  RJ: "Rio de Janeiro",
  RN: "Rio Grande do Norte",
  RS: "Rio Grande do Sul",
  RO: "Rondônia",
  RR: "Roraima",
  SC: "Santa Catarina",
  SP: "São Paulo",
  SE: "Sergipe",
  TO: "Tocantins",
};

function addressError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeStreet(value) {
  return normalizeText(value).replace(
    /^(rua|r|avenida|av|estrada|rodovia|travessa|tv|praca|largo|alameda)\s+/,
    "",
  );
}

function matchesStreet(expected, actual) {
  const normalizedExpected = normalizeStreet(expected);
  const normalizedActual = normalizeStreet(actual);
  return Boolean(
    normalizedExpected &&
    normalizedActual &&
    (normalizedExpected === normalizedActual ||
      normalizedExpected.includes(normalizedActual) ||
      normalizedActual.includes(normalizedExpected)),
  );
}

function matchesCity(expected, details) {
  const normalizedExpected = normalizeText(expected);
  const candidates = [
    details.city,
    details.town,
    details.municipality,
    details.village,
    details.city_district,
  ].map(normalizeText);
  return candidates.some((candidate) => candidate && candidate === normalizedExpected);
}

function matchesState(expected, details) {
  const normalizedExpected = normalizeText(expected);
  const stateCode = Object.keys(BRAZILIAN_STATES).find(
    (code) => normalizeText(code) === normalizedExpected || normalizeText(BRAZILIAN_STATES[code]) === normalizedExpected,
  );
  const isoCode = String(details["ISO3166-2-lvl4"] || details["ISO3166-2-lvl3"] || "")
    .split("-")
    .pop()
    .toUpperCase();
  return Boolean(
    (stateCode && isoCode === stateCode) ||
    normalizeText(details.state) === normalizedExpected ||
    (stateCode && normalizeText(details.state) === normalizeText(BRAZILIAN_STATES[stateCode])),
  );
}

function validCoordinates(candidate) {
  const latitude = Number(candidate?.lat);
  const longitude = Number(candidate?.lon);
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

function candidateStreet(candidate) {
  const details = candidate?.address || {};
  return details.road || details.pedestrian || details.residential || details.street || "";
}

function candidateDistanceKm(origin, candidate) {
  if (!validCoordinates(candidate)) return null;
  const originLatitude = Number(origin?.latitude);
  const originLongitude = Number(origin?.longitude);
  if (
    !Number.isFinite(originLatitude) || originLatitude < -90 || originLatitude > 90
    || !Number.isFinite(originLongitude) || originLongitude < -180 || originLongitude > 180
  ) return null;

  const earthRadiusKm = 6371;
  const toRad = (value) => (value * Math.PI) / 180;
  const latitude = Number(candidate.lat);
  const longitude = Number(candidate.lon);
  const latitudeDelta = toRad(latitude - originLatitude);
  const longitudeDelta = toRad(longitude - originLongitude);
  const firstLatitude = toRad(originLatitude);
  const secondLatitude = toRad(latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function candidateRejectionReasons(candidate, address, { exact = false } = {}) {
  const details = candidate?.address || {};
  const expectedPostalCode = postalCodeDigits(address.postalCode);
  const returnedPostalCode = postalCodeDigits(details.postcode);
  const reasons = [];
  if (!validCoordinates(candidate)) reasons.push("INVALID_COORDINATES");
  if (details.country_code !== "br") reasons.push("COUNTRY_MISMATCH");
  if (exact && normalizeText(details.house_number) !== normalizeText(address.number)) reasons.push("HOUSE_NUMBER_MISMATCH");
  if (!matchesStreet(address.street, candidateStreet(candidate))) reasons.push("STREET_MISMATCH");
  if (!matchesCity(address.city, details)) reasons.push("CITY_MISMATCH");
  if (!matchesState(address.state, details)) reasons.push("STATE_MISMATCH");
  if (exact && returnedPostalCode && returnedPostalCode !== expectedPostalCode) reasons.push("POSTCODE_MISMATCH");
  return reasons;
}

function candidateDiagnostic(candidate, reasons, distanceKm) {
  const details = candidate?.address || {};
  return {
    latitude: Number(candidate?.lat),
    longitude: Number(candidate?.lon),
    displayName: candidate?.display_name || "",
    road: candidateStreet(candidate),
    neighborhood: details.suburb || details.neighbourhood || details.quarter || "",
    city: details.city || details.town || details.municipality || details.village || details.city_district || "",
    state: details.state || "",
    postcode: details.postcode || "",
    countryCode: details.country_code || "",
    type: candidate?.type || "",
    addresstype: candidate?.addresstype || "",
    distanceFromStoreKm: Number.isFinite(distanceKm) ? Math.round(distanceKm * 100) / 100 : null,
    decision: reasons.length ? "rejected" : "compatible",
    reasons,
  };
}

function developmentGeocodingLog(event, payload) {
  if (import.meta.env?.DEV) console.debug(`[address-geocoding] ${event}`, payload);
}

function selectNominatimCandidate(candidates, address, {
  exact = false,
  origin,
  maximumCandidateDistanceKm,
} = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const evaluated = list.map((candidate, index) => {
    const reasons = candidateRejectionReasons(candidate, address, { exact });
    const distanceKm = candidateDistanceKm(origin, candidate);
    return { candidate, index, reasons, distanceKm };
  });
  const compatible = evaluated
    .filter((item) => item.reasons.length === 0)
    .sort((first, second) => {
      if (Number.isFinite(first.distanceKm) && Number.isFinite(second.distanceKm)) return first.distanceKm - second.distanceKm;
      if (Number.isFinite(first.distanceKm)) return -1;
      if (Number.isFinite(second.distanceKm)) return 1;
      return first.index - second.index;
    });
  const maximumDistance = Number(maximumCandidateDistanceKm);
  const plausible = Number.isFinite(maximumDistance) && maximumDistance > 0
    ? compatible.filter((item) => !Number.isFinite(item.distanceKm) || item.distanceKm <= maximumDistance)
    : compatible;
  const selected = plausible[0] || null;
  const stage = exact ? "nominatim_exact" : "nominatim_street";
  const emptyCode = exact ? "NOMINATIM_EXACT_NOT_FOUND" : "NOMINATIM_STREET_NOT_FOUND";
  const diagnosticCode = list.length === 0
    ? emptyCode
    : compatible.length > 0 && plausible.length === 0
      ? "CANDIDATE_OUTSIDE_EXPECTED_REGION"
      : evaluated.flatMap((item) => item.reasons).find((reason) => [
          "STREET_MISMATCH", "CITY_MISMATCH", "STATE_MISMATCH", "INVALID_COORDINATES",
        ].includes(reason)) || emptyCode;

  developmentGeocodingLog(stage, {
    code: selected ? "CANDIDATE_SELECTED" : diagnosticCode,
    viaCep: {
      postalCode: address.postalCode,
      street: address.street,
      neighborhood: address.neighborhood,
      city: address.city,
      state: address.state,
    },
    candidateCount: list.length,
    compatibleCount: compatible.length,
    candidates: evaluated.map((item) => candidateDiagnostic(item.candidate, item.reasons, item.distanceKm)),
    selected: selected ? candidateDiagnostic(selected.candidate, [], selected.distanceKm) : null,
  });

  return { candidate: selected?.candidate || null, diagnosticCode };
}

function isPostalAddressCompatible(address, postalAddress) {
  return Boolean(
    postalCodeDigits(postalAddress.postalCode) === postalCodeDigits(address.postalCode) &&
    postalAddress.street &&
    matchesStreet(address.street, postalAddress.street) &&
    normalizeText(postalAddress.city) === normalizeText(address.city) &&
    matchesState(address.state, { state: postalAddress.state })
  );
}

async function waitForNominatimRateLimit() {
  const waitMs = Math.max(0, NOMINATIM_REQUEST_INTERVAL_MS - (Date.now() - lastNominatimRequestAt));
  if (waitMs > 0) await new Promise((resolve) => globalThis.setTimeout(resolve, waitMs));
  lastNominatimRequestAt = Date.now();
}

function loadNominatimJsonp(parameters, signal) {
  return new Promise((resolve, reject) => {
    const callbackName = `__rafaGeocode_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const callbackTarget = /** @type {Record<string, unknown>} */ (globalThis);
    const script = document.createElement("script");
    const timeout = globalThis.setTimeout(() => {
      cleanup();
      reject(addressError("GEOCODING_UNAVAILABLE", "Não foi possível validar o endereço agora. Tente novamente."));
    }, 12_000);

    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener("abort", abortRequest);
      script.remove();
      delete callbackTarget[callbackName];
    };
    const abortRequest = () => {
      cleanup();
      reject(new DOMException("A consulta foi cancelada.", "AbortError"));
    };

    callbackTarget[callbackName] = (data) => {
      cleanup();
      resolve(data);
    };
    parameters.set("json_callback", callbackName);
    script.src = `${NOMINATIM_ENDPOINT}?${parameters}`;
    script.async = true;
    script.referrerPolicy = "strict-origin-when-cross-origin";
    script.onerror = () => {
      cleanup();
      reject(addressError("GEOCODING_UNAVAILABLE", "Não foi possível validar o endereço agora. Tente novamente."));
    };

    if (signal?.aborted) {
      abortRequest();
      return;
    }
    signal?.addEventListener("abort", abortRequest, { once: true });
    document.head.append(script);
  });
}

async function requestNominatimCandidates(parameters, signal) {
  if (typeof document !== "undefined") return loadNominatimJsonp(parameters, signal);

  let response;
  try {
    response = await fetch(`${NOMINATIM_ENDPOINT}?${parameters}`, {
      signal,
      headers: { Accept: "application/json", "User-Agent": "RafaDeliveryGeocoder/1.0" },
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw addressError("GEOCODING_UNAVAILABLE", "Não foi possível validar o endereço agora. Tente novamente.");
  }
  if (!response.ok) {
    throw addressError("GEOCODING_UNAVAILABLE", "Não foi possível validar o endereço agora. Tente novamente.");
  }
  try {
    return await response.json();
  } catch {
    throw addressError("GEOCODING_UNAVAILABLE", "Não foi possível validar o endereço agora. Tente novamente.");
  }
}

export function postalCodeDigits(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 8);
}

export function formatPostalCode(value) {
  const digits = postalCodeDigits(value);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

export function validateDeliveryAddressFields(address) {
  if (postalCodeDigits(address.postalCode).length !== 8) return "Informe um CEP válido com 8 dígitos.";
  if (!address.street?.trim()) return "Informe a rua do endereço de entrega.";
  if (!address.number?.trim()) return "Informe o número do endereço de entrega.";
  if (!address.neighborhood?.trim()) return "Informe o bairro do endereço de entrega.";
  if (!address.city?.trim()) return "Informe a cidade do endereço de entrega.";
  if (!address.state?.trim()) return "Informe o estado do endereço de entrega.";
  return "";
}

export function composeDeliveryAddress(address) {
  const postalCode = formatPostalCode(address.postalCode);
  return [
    [address.street?.trim(), address.number?.trim()].filter(Boolean).join(", "),
    address.complement?.trim(),
    address.neighborhood?.trim(),
    [address.city?.trim(), address.state?.trim()?.toUpperCase()].filter(Boolean).join(" - "),
    postalCode ? `CEP ${postalCode}` : "",
  ].filter(Boolean).join(", ");
}

/** Reverse geocoding is only used to prefill the form. The supplied GPS coordinate remains authoritative. */
export async function reverseGeocodeCoordinates({ latitude, longitude }, { signal } = {}) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw addressError("GPS_INVALID_COORDINATES", "O aparelho retornou uma localização inválida.");
  }
  const parameters = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    format: "jsonv2",
    addressdetails: "1",
    zoom: "18",
    "accept-language": "pt-BR",
  });
  const result = await requestNominatimCandidates(parameters, signal);
  const row = Array.isArray(result) ? result[0] : result;
  const address = row?.address || {};
  return {
    street: address.road || address.pedestrian || address.residential || address.footway || "",
    neighborhood: address.suburb || address.neighbourhood || address.quarter || "",
    city: address.city || address.town || address.village || address.municipality || "",
    state: address.state_code?.replace(/^BR-/i, "") || address.state || "",
    postalCode: formatPostalCode(address.postcode || ""),
    displayName: row?.display_name || "",
    geocodingSource: "nominatim_reverse",
  };
}

/** @param {string} value @param {{ signal?: AbortSignal }} [options] */
export async function lookupPostalCode(value, { signal } = {}) {
  const postalCode = postalCodeDigits(value);
  if (postalCode.length !== 8) {
    throw addressError("INVALID_POSTAL_CODE", "Informe um CEP válido com 8 dígitos.");
  }
  if (postalCodeCache.has(postalCode)) return postalCodeCache.get(postalCode);

  let response;
  try {
    response = await fetch(`${VIA_CEP_ENDPOINT}/${postalCode}/json/`, {
      signal,
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw addressError("POSTAL_CODE_SERVICE_UNAVAILABLE", "Não foi possível consultar o CEP agora. Tente novamente.");
  }

  if (!response.ok) {
    throw addressError("POSTAL_CODE_SERVICE_UNAVAILABLE", "Não foi possível consultar o CEP agora. Tente novamente.");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw addressError("POSTAL_CODE_SERVICE_UNAVAILABLE", "Não foi possível consultar o CEP agora. Tente novamente.");
  }
  if (data.erro) throw addressError("POSTAL_CODE_NOT_FOUND", "CEP não encontrado. Revise os 8 dígitos informados.");

  const result = {
    postalCode: formatPostalCode(data.cep || postalCode),
    street: data.logradouro || "",
    neighborhood: data.bairro || "",
    city: data.localidade || "",
    state: data.uf || "",
  };
  postalCodeCache.set(postalCode, result);
  return result;
}

/** @param {Record<string, string>} address @param {{ signal?: AbortSignal }} [options] */
export async function validateDeliveryPostalAddress(address, { signal } = {}) {
  const validationMessage = validateDeliveryAddressFields(address);
  if (validationMessage) throw addressError("INVALID_ADDRESS", validationMessage);

  const postalAddress = await lookupPostalCode(address.postalCode, { signal });
  if (!isPostalAddressCompatible(address, postalAddress)) {
    throw addressError(
      "ADDRESS_POSTAL_CODE_MISMATCH",
      "O CEP não corresponde à rua, cidade ou estado informado. Revise os dados do endereço.",
    );
  }
  return postalAddress;
}

/** @param {Record<string, string>} address @param {{ signal?: AbortSignal, postalAddress?: Record<string, string> }} [options] */
export async function geocodeDeliveryAddress(address, {
  signal,
  postalAddress: suppliedPostalAddress,
  origin,
  maximumCandidateDistanceKm,
} = {}) {
  const validationMessage = validateDeliveryAddressFields(address);
  if (validationMessage) throw addressError("INVALID_ADDRESS", validationMessage);

  const postalAddress = suppliedPostalAddress || await validateDeliveryPostalAddress(address, { signal });
  if (!isPostalAddressCompatible(address, postalAddress)) {
    throw addressError(
      "ADDRESS_POSTAL_CODE_MISMATCH",
      "O CEP não corresponde à rua, cidade ou estado informado. Revise os dados do endereço.",
    );
  }

  const query = [
    `${address.street.trim()}, ${address.number.trim()}`,
    address.neighborhood.trim(),
    `${address.city.trim()} - ${address.state.trim()}`,
    formatPostalCode(address.postalCode),
    "Brasil",
  ].join(", ");
  const cacheKey = normalizeText(query);
  if (geocodingCache.has(cacheKey)) return geocodingCache.get(cacheKey);

  await waitForNominatimRateLimit();
  const parameters = new URLSearchParams({
    q: query,
    format: "jsonv2",
    addressdetails: "1",
    countrycodes: "br",
    layer: "address",
    limit: "5",
    "accept-language": "pt-BR",
  });

  const candidates = await requestNominatimCandidates(parameters, signal);
  const preciseSelection = selectNominatimCandidate(candidates, address, {
    exact: true,
    origin,
  });
  const preciseCandidate = preciseSelection.candidate;
  if (preciseCandidate) {
    const result = {
      latitude: Number(preciseCandidate.lat),
      longitude: Number(preciseCandidate.lon),
      displayName: preciseCandidate.display_name,
      precision: "exact",
      source: "nominatim_exact",
      postalCode: formatPostalCode(preciseCandidate.address?.postcode || address.postalCode),
      type: preciseCandidate.type || null,
      addresstype: preciseCandidate.addresstype || null,
    };
    geocodingCache.set(cacheKey, result);
    return result;
  }

  const streetQuery = [
    address.street.trim(),
    `${address.city.trim()} - ${address.state.trim()}`,
    "Brasil",
  ].join(", ");
  await waitForNominatimRateLimit();
  const streetParameters = new URLSearchParams({
    q: streetQuery,
    format: "jsonv2",
    addressdetails: "1",
    countrycodes: "br",
    limit: "5",
    "accept-language": "pt-BR",
  });
  const streetCandidates = await requestNominatimCandidates(streetParameters, signal);
  const streetSelection = selectNominatimCandidate(streetCandidates, address, {
    origin,
    maximumCandidateDistanceKm,
  });
  const streetCandidate = streetSelection.candidate;
  if (!streetCandidate) {
    const error = addressError(
      "ADDRESS_NOT_PRECISE",
      "O endereço não pôde ser localizado. Revise CEP, rua, número, bairro e cidade.",
    );
    error.diagnosticCode = streetSelection.diagnosticCode;
    throw error;
  }

  return {
    latitude: Number(streetCandidate.lat),
    longitude: Number(streetCandidate.lon),
    displayName: streetCandidate.display_name,
    precision: "street",
    source: "nominatim_street",
    postalCode: formatPostalCode(address.postalCode),
    type: streetCandidate.type || null,
    addresstype: streetCandidate.addresstype || null,
  };
}
