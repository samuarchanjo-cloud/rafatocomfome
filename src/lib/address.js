import { MIN_ADDRESS_UNCERTAINTY_M } from "./location.js";

const VIA_CEP_ENDPOINT = "https://viacep.com.br/ws";
const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";
const AWESOME_CEP_ENDPOINT = "https://cep.awesomeapi.com.br/json";
const NOMINATIM_REQUEST_INTERVAL_MS = 1_000;
const GEOCODING_AGREEMENT_TOLERANCE_KM = 1;

const postalCodeCache = new Map();
const geocodingCache = new Map();
const postalCoordinatesCache = new Map();
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

function addressError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function isDevelopmentEnvironment() {
  return Boolean(import.meta.env?.DEV) || (typeof process !== "undefined" && process.env?.NODE_ENV === "development");
}

function logGeocoding(source, result, extra = {}) {
  if (!isDevelopmentEnvironment()) return;
  console.debug("[delivery-geocoding]", {
    source,
    latitude: result?.latitude ?? null,
    longitude: result?.longitude ?? null,
    precision: result?.precision ?? null,
    postalCode: result?.postalCode ?? null,
    type: result?.type ?? null,
    addresstype: result?.addresstype ?? null,
    ...extra,
  });
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

function candidateMetadata(candidate) {
  return {
    postalCode: formatPostalCode(candidate?.address?.postcode || ""),
    type: candidate?.type || null,
    addresstype: candidate?.addresstype || null,
    placeRank: Number.isFinite(Number(candidate?.place_rank)) ? Number(candidate.place_rank) : null,
    boundingBox: Array.isArray(candidate?.boundingbox) ? candidate.boundingbox.map(Number) : null,
    boundingBoxRadiusM: boundingBoxRadiusM(candidate),
  };
}

function isHouseLevelCandidate(candidate) {
  const type = normalizeText(candidate?.type);
  const addresstype = normalizeText(candidate?.addresstype);
  const placeRank = Number(candidate?.place_rank);
  if ([type, addresstype].some((value) => ["road", "street"].includes(value))) return false;
  return !Number.isFinite(placeRank) || placeRank >= 28;
}

function isRoadLevelCandidate(candidate) {
  const category = normalizeText(candidate?.category || candidate?.class);
  const type = normalizeText(candidate?.type);
  const addresstype = normalizeText(candidate?.addresstype);
  const placeRank = Number(candidate?.place_rank);
  const roadLike =
    category === "highway" ||
    ["road", "street"].includes(addresstype) ||
    ["residential", "living street", "service", "unclassified", "tertiary", "secondary", "primary"].includes(type);
  return roadLike && (!Number.isFinite(placeRank) || placeRank >= 26);
}

function distanceBetweenCoordinatesKm(first, second) {
  const earthRadiusKm = 6371;
  const toRad = (value) => (value * Math.PI) / 180;
  const latitudeDifference = toRad(second.latitude - first.latitude);
  const longitudeDifference = toRad(second.longitude - first.longitude);
  const firstLatitude = toRad(first.latitude);
  const secondLatitude = toRad(second.latitude);
  const a =
    Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDifference / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function boundingBoxRadiusM(candidate) {
  const values = Array.isArray(candidate?.boundingbox) ? candidate.boundingbox.map(Number) : [];
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return 0;
  const [south, north, west, east] = values;
  if (
    south < -90 || north > 90 || west < -180 || east > 180 ||
    south > north || west > east
  ) {
    return 0;
  }

  const center = { latitude: Number(candidate.lat), longitude: Number(candidate.lon) };
  if (!Number.isFinite(center.latitude) || !Number.isFinite(center.longitude)) return 0;
  const corners = [
    { latitude: south, longitude: west },
    { latitude: south, longitude: east },
    { latitude: north, longitude: west },
    { latitude: north, longitude: east },
  ];
  return Math.ceil(Math.max(...corners.map((corner) => distanceBetweenCoordinatesKm(center, corner))) * 1000);
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

function isPreciseAddressCandidate(candidate, address) {
  const details = candidate?.address || {};
  const latitude = Number(candidate?.lat);
  const longitude = Number(candidate?.lon);
  const expectedPostalCode = postalCodeDigits(address.postalCode);
  const returnedPostalCode = postalCodeDigits(details.postcode);
  const returnedStreet = details.road || details.pedestrian || details.residential || details.street;

  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    details.country_code === "br" &&
    normalizeText(details.house_number) === normalizeText(address.number) &&
    isHouseLevelCandidate(candidate) &&
    matchesStreet(address.street, returnedStreet) &&
    matchesCity(address.city, details) &&
    matchesState(address.state, details) &&
    (!returnedPostalCode || returnedPostalCode === expectedPostalCode)
  );
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

function isCompatibleApproximatePostalCode(expected, returned) {
  const expectedDigits = postalCodeDigits(expected);
  const returnedDigits = postalCodeDigits(returned);
  return Boolean(returnedDigits && returnedDigits === expectedDigits);
}

function isApproximateAddressCandidate(candidate, address) {
  const details = candidate?.address || {};
  const latitude = Number(candidate?.lat);
  const longitude = Number(candidate?.lon);
  const expectedPostalCode = postalCodeDigits(address.postalCode);
  const returnedPostalCode = postalCodeDigits(details.postcode);
  const returnedStreet = details.road || details.pedestrian || details.residential || details.street;

  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    details.country_code === "br" &&
    isCompatibleApproximatePostalCode(expectedPostalCode, returnedPostalCode) &&
    isRoadLevelCandidate(candidate) &&
    matchesStreet(address.street, returnedStreet) &&
    matchesCity(address.city, details) &&
    matchesState(address.state, details)
  );
}

function geocodingParameters(query) {
  return new URLSearchParams({
    q: query,
    format: "jsonv2",
    addressdetails: "1",
    countrycodes: "br",
    layer: "address",
    limit: "5",
    "accept-language": "pt-BR",
  });
}

function coordinatesFromCandidate(candidate, precision) {
  const metadata = candidateMetadata(candidate);
  return {
    latitude: Number(candidate.lat),
    longitude: Number(candidate.lon),
    displayName: candidate.display_name,
    precision,
    source: precision === "exact" ? "nominatim_exact" : "nominatim_approximate",
    ...metadata,
  };
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
      headers: { Accept: "application/json" },
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

async function lookupPostalCoordinates(address, signal) {
  const postalCode = postalCodeDigits(address.postalCode);
  if (postalCoordinatesCache.has(postalCode)) return postalCoordinatesCache.get(postalCode);

  let response;
  try {
    response = await fetch(`${AWESOME_CEP_ENDPOINT}/${postalCode}`, {
      signal,
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw addressError("GEOCODING_UNAVAILABLE", "O serviço de coordenadas por CEP está temporariamente indisponível.", {
      service: "awesomeapi_cep",
    });
  }
  if (!response.ok) {
    if (response.status === 404) return null;
    throw addressError("GEOCODING_UNAVAILABLE", "O serviço de coordenadas por CEP está temporariamente indisponível.", {
      service: "awesomeapi_cep",
    });
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw addressError("GEOCODING_UNAVAILABLE", "O serviço de coordenadas por CEP retornou uma resposta inválida.", {
      service: "awesomeapi_cep",
    });
  }

  const latitude = Number(data.lat);
  const longitude = Number(data.lng);
  const compatible =
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    postalCodeDigits(data.cep) === postalCode &&
    matchesStreet(address.street, data.address) &&
    normalizeText(address.city) === normalizeText(data.city) &&
    matchesState(address.state, { state: data.state });
  if (!compatible) return null;

  const result = {
    latitude,
    longitude,
    displayName: [data.address, data.district, data.city, data.state, formatPostalCode(data.cep)].filter(Boolean).join(", "),
    precision: "approximate",
    source: "awesomeapi_cep",
    postalCode: formatPostalCode(data.cep),
    type: data.address_type || "postcode",
    addresstype: "postcode",
    placeRank: null,
  };
  postalCoordinatesCache.set(postalCode, result);
  return result;
}

function buildAddressConsensus(nominatimResult, postalResult) {
  if (!postalResult) return null;

  let differenceKm = 0;
  if (nominatimResult) {
    differenceKm = distanceBetweenCoordinatesKm(nominatimResult, postalResult);
    if (differenceKm > GEOCODING_AGREEMENT_TOLERANCE_KM) {
      const sources = [nominatimResult, postalResult];
      logGeocoding("ambiguous", null, { precision: "ambiguous", differenceKm, sources });
      throw addressError(
        "ADDRESS_AMBIGUOUS",
        "Não foi possível confirmar precisamente a localização. Revise o endereço e tente novamente.",
        { precision: "ambiguous", sources, differenceKm },
      );
    }
  }

  const uncertainty = Math.ceil(Math.max(
    MIN_ADDRESS_UNCERTAINTY_M,
    Number(nominatimResult?.boundingBoxRadiusM) || 0,
    differenceKm * 1000,
  ));
  const result = {
    ...postalResult,
    precision: "consensus",
    source: "address_consensus",
    uncertainty,
    agreementDistanceKm: nominatimResult ? differenceKm : null,
    alternatives: nominatimResult ? [nominatimResult, postalResult] : [postalResult],
  };
  logGeocoding("address_consensus", result, {
    agreementDistanceKm: result.agreementDistanceKm,
    uncertaintyM: uncertainty,
  });
  return result;
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
    `${address.street.trim()}, ${address.number.trim()}`,
    address.complement?.trim(),
    address.neighborhood.trim(),
    `${address.city.trim()} - ${address.state.trim().toUpperCase()}`,
    `CEP ${postalCode}`,
  ].filter(Boolean).join(", ");
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
export async function geocodeDeliveryAddress(address, { signal } = {}) {
  const validationMessage = validateDeliveryAddressFields(address);
  if (validationMessage) throw addressError("INVALID_ADDRESS", validationMessage);
  const postalAddress = await lookupPostalCode(address.postalCode, { signal });
  if (!isPostalAddressCompatible(address, postalAddress)) {
    throw addressError(
      "ADDRESS_POSTAL_CODE_MISMATCH",
      "O CEP não corresponde à rua, cidade ou estado informado. Revise os dados do endereço.",
    );
  }

  const preciseQuery = [
    `${address.street.trim()}, ${address.number.trim()}`,
    address.neighborhood.trim(),
    `${address.city.trim()} - ${address.state.trim()}`,
    formatPostalCode(address.postalCode),
    "Brasil",
  ].join(", ");
  const preciseCacheKey = `precise:${normalizeText(preciseQuery)}`;
  const cachedPreciseResult = geocodingCache.get(preciseCacheKey);
  if (cachedPreciseResult?.precision === "exact") return cachedPreciseResult;

  let nominatimUnavailableError = null;
  let preciseCandidate = null;
  try {
    await waitForNominatimRateLimit();
    const preciseCandidates = await requestNominatimCandidates(geocodingParameters(preciseQuery), signal);
    preciseCandidate = Array.isArray(preciseCandidates)
      ? preciseCandidates.find((candidate) => isPreciseAddressCandidate(candidate, address))
      : null;
  } catch (error) {
    if (error.name === "AbortError") throw error;
    if (error.code !== "GEOCODING_UNAVAILABLE") throw error;
    nominatimUnavailableError = error;
  }
  if (preciseCandidate) {
    const preciseResult = coordinatesFromCandidate(preciseCandidate, "exact");
    geocodingCache.set(preciseCacheKey, preciseResult);
    logGeocoding("nominatim_exact", preciseResult);
    return preciseResult;
  }

  const approximateQuery = [
    address.street.trim(),
    address.neighborhood.trim(),
    `${address.city.trim()} - ${address.state.trim()}`,
    formatPostalCode(address.postalCode),
    "Brasil",
  ].join(", ");
  const approximateCacheKey = `nominatim-approximate:${normalizeText(approximateQuery)}`;
  let nominatimApproximateResult = geocodingCache.get(approximateCacheKey) || null;

  if (!nominatimApproximateResult && !nominatimUnavailableError) {
    try {
      await waitForNominatimRateLimit();
      const approximateCandidates = await requestNominatimCandidates(geocodingParameters(approximateQuery), signal);
      const approximateCandidate = Array.isArray(approximateCandidates)
        ? approximateCandidates.find((candidate) => isApproximateAddressCandidate(candidate, address))
        : null;
      if (approximateCandidate) {
        nominatimApproximateResult = coordinatesFromCandidate(approximateCandidate, "approximate");
        geocodingCache.set(approximateCacheKey, nominatimApproximateResult);
      }
    } catch (error) {
      if (error.name === "AbortError") throw error;
      if (error.code !== "GEOCODING_UNAVAILABLE") throw error;
      nominatimUnavailableError = error;
    }
  }

  let postalResult = null;
  let postalServiceUnavailableError = null;
  try {
    postalResult = await lookupPostalCoordinates(address, signal);
  } catch (error) {
    if (error.name === "AbortError") throw error;
    if (error.code !== "GEOCODING_UNAVAILABLE") throw error;
    postalServiceUnavailableError = error;
  }

  const consensusResult = buildAddressConsensus(nominatimApproximateResult, postalResult);
  if (consensusResult) return consensusResult;

  if (nominatimUnavailableError || postalServiceUnavailableError) {
    const sources = [nominatimApproximateResult, postalResult].filter(Boolean);
    throw addressError(
      "GEOCODING_UNAVAILABLE",
      "Não foi possível consultar todos os serviços de localização agora. Tente novamente em instantes.",
      {
        services: [nominatimUnavailableError?.service || "nominatim", postalServiceUnavailableError?.service]
          .filter(Boolean),
        sources,
        mapCandidate: postalResult || nominatimApproximateResult || null,
      },
    );
  }

  const sources = [nominatimApproximateResult, postalResult].filter(Boolean);
  throw addressError(
    "ADDRESS_NOT_PRECISE",
    "O endereço não pôde ser localizado. Revise CEP, rua, número, bairro, cidade e estado.",
    { sources, mapCandidate: postalResult || nominatimApproximateResult || null },
  );
}
