export const MAX_DEVICE_GPS_ACCURACY_M = 150;
export const MIN_ADDRESS_UNCERTAINTY_M = 750;

export const DEVICE_GPS_OPTIONS = Object.freeze({
  enableHighAccuracy: true,
  timeout: 15000,
  maximumAge: 0,
});

const TRUSTED_EXACT_LOCATION_SOURCES = new Set(["nominatim_exact", "google_exact", "device_gps", "map_pin"]);

function locationError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function isTrustedDeliveryLocation(location) {
  if (!location) {
    return false;
  }

  if (location.source === "postal_zone") {
    return (
      location.precision === "administrative" &&
      /^\d{8}$/.test(String(location.postalCode || "")) &&
      Number.isFinite(Number(location.deliveryFee)) &&
      Number(location.deliveryFee) >= 0
    );
  }

  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return false;
  }

  if (location.source === "address_consensus") {
    return (
      location.precision === "consensus" &&
      Number.isFinite(Number(location.uncertainty)) &&
      Number(location.uncertainty) >= MIN_ADDRESS_UNCERTAINTY_M
    );
  }

  if (location.precision !== "exact" || !TRUSTED_EXACT_LOCATION_SOURCES.has(location.source)) return false;
  if (["nominatim_exact", "google_exact", "map_pin"].includes(location.source)) return true;

  return (
    Number.isFinite(Number(location.accuracy)) &&
    Number(location.accuracy) > 0 &&
    Number(location.accuracy) <= MAX_DEVICE_GPS_ACCURACY_M
  );
}

export function createDeviceGpsLocation(coords, { confirmed = false } = {}) {
  if (!confirmed) {
    throw locationError(
      "GPS_CONFIRMATION_REQUIRED",
      "Confirme que você está no endereço de entrega antes de usar sua localização.",
    );
  }

  const latitude = Number(coords?.latitude);
  const longitude = Number(coords?.longitude);
  const accuracy = Number(coords?.accuracy);

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw locationError("GPS_INVALID_COORDINATES", "O aparelho retornou uma localização inválida.");
  }

  if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > MAX_DEVICE_GPS_ACCURACY_M) {
    throw locationError(
      "GPS_INACCURATE",
      "Não conseguimos obter sua localização com precisão suficiente. Ative a localização precisa do aparelho e tente novamente.",
    );
  }

  return {
    latitude,
    longitude,
    accuracy,
    precision: "exact",
    source: "device_gps",
  };
}

export function requestDeviceGps({
  confirmed = false,
  geolocation = globalThis.navigator?.geolocation,
  options = DEVICE_GPS_OPTIONS,
} = {}) {
  if (!confirmed) {
    return Promise.reject(
      locationError(
        "GPS_CONFIRMATION_REQUIRED",
        "Confirme que você está no endereço de entrega antes de usar sua localização.",
      ),
    );
  }

  if (!geolocation?.getCurrentPosition) {
    return Promise.reject(
      locationError("GPS_UNAVAILABLE", "A localização do aparelho não está disponível neste navegador."),
    );
  }

  return new Promise((resolve, reject) => {
    geolocation.getCurrentPosition(
      (position) => {
        try {
          resolve(createDeviceGpsLocation(position?.coords, { confirmed: true }));
        } catch (error) {
          reject(error);
        }
      },
      (error) => {
        const errorsByCode = {
          1: ["GPS_PERMISSION_DENIED", "A permissão de localização foi negada. Permita o acesso ou revise o endereço."],
          2: ["GPS_UNAVAILABLE", "Não foi possível obter a localização do aparelho. Tente novamente ou revise o endereço."],
          3: ["GPS_TIMEOUT", "A localização demorou demais para responder. Tente novamente ou revise o endereço."],
        };
        const [code, message] = errorsByCode[error?.code] || errorsByCode[2];
        reject(locationError(code, message));
      },
      { ...DEVICE_GPS_OPTIONS, ...options },
    );
  });
}
