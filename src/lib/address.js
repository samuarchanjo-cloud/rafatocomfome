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
    matchesStreet(address.street, returnedStreet) &&
    matchesCity(address.city, details) &&
    matchesState(address.state, details) &&
    (!returnedPostalCode || returnedPostalCode === expectedPostalCode)
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
  const preciseCandidate = Array.isArray(candidates)
    ? candidates.find((candidate) => isPreciseAddressCandidate(candidate, address))
    : null;
  if (!preciseCandidate) {
    throw addressError(
      "ADDRESS_NOT_PRECISE",
      "O endereço não pôde ser localizado com precisão. Revise CEP, rua, número, bairro e cidade.",
    );
  }

  const result = {
    latitude: Number(preciseCandidate.lat),
    longitude: Number(preciseCandidate.lon),
    displayName: preciseCandidate.display_name,
  };
  geocodingCache.set(cacheKey, result);
  return result;
}
