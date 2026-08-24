const OPENROUTESERVICE_DIRECTIONS_URL = "https://api.openrouteservice.org/v2/directions/driving-car";

function validCoordinates(point) {
  const latitude = Number(point?.latitude);
  const longitude = Number(point?.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90
    && longitude >= -180 && longitude <= 180;
}

function roundDistance(value) {
  return Math.round(Number(value) * 100) / 100;
}

export function haversineDistanceKm(origin, destination) {
  if (!validCoordinates(origin) || !validCoordinates(destination)) throw new Error("INVALID_COORDINATES");
  const earthRadiusKm = 6371;
  const toRad = (value) => (value * Math.PI) / 180;
  const latDiff = toRad(Number(destination.latitude) - Number(origin.latitude));
  const lonDiff = toRad(Number(destination.longitude) - Number(origin.longitude));
  const originLat = toRad(Number(origin.latitude));
  const destinationLat = toRad(Number(destination.latitude));
  const a = Math.sin(latDiff / 2) ** 2
    + Math.cos(originLat) * Math.cos(destinationLat) * Math.sin(lonDiff / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function requestOpenRouteService(origin, destination, {
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
} = {}) {
  if (!validCoordinates(origin) || !validCoordinates(destination)) throw new Error("INVALID_COORDINATES");
  if (!apiKey) throw new Error("OPENROUTESERVICE_NOT_CONFIGURED");

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(OPENROUTESERVICE_DIRECTIONS_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        coordinates: [
          [Number(origin.longitude), Number(origin.latitude)],
          [Number(destination.longitude), Number(destination.latitude)],
        ],
        instructions: false,
      }),
    });
    if (!response.ok) throw new Error(`OPENROUTESERVICE_HTTP_${response.status}`);
    const data = await response.json();
    const summary = data?.routes?.[0]?.summary;
    const distanceKm = Number(summary?.distance) / 1000;
    const durationMinutes = Number(summary?.duration) / 60;
    if (!Number.isFinite(distanceKm) || distanceKm <= 0 || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      throw new Error("OPENROUTESERVICE_INVALID_RESPONSE");
    }
    return {
      distanceKm: roundDistance(distanceKm),
      durationMinutes: Math.round(durationMinutes * 10) / 10,
      source: "openrouteservice",
    };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function calculateRouteWithFallback(origin, destination, options = {}) {
  try {
    return await requestOpenRouteService(origin, destination, options);
  } catch (error) {
    options.onFallback?.(error);
    return {
      distanceKm: roundDistance(haversineDistanceKm(origin, destination)),
      durationMinutes: null,
      source: "haversine_fallback",
    };
  }
}

export function evaluateRouteQuote(distanceKm, ranges, settings) {
  const distance = roundDistance(distanceKm);
  const maximum = Number(settings?.maximum_delivery_distance_km);
  if (!Number.isFinite(distance) || distance < 0) throw new Error("INVALID_ROUTE_DISTANCE");
  if (!Number.isFinite(maximum) || maximum <= 0) throw new Error("DELIVERY_NOT_CONFIGURED");
  if (distance > maximum) {
    return { allowed: false, uberAvailable: true, deliveryFee: 0, code: "UBER_AVAILABLE" };
  }

  if (distance <= 1) {
    const behavior = settings?.below_one_km_behavior;
    if (behavior === "free") return { allowed: true, uberAvailable: false, deliveryFee: 0, code: "FREE" };
    if (behavior === "fixed") {
      const fee = Number(settings?.below_one_km_fee);
      if (!Number.isFinite(fee) || fee < 0) throw new Error("DELIVERY_NOT_CONFIGURED");
      return { allowed: true, uberAvailable: false, deliveryFee: fee, code: "FIXED" };
    }
    throw new Error("BELOW_ONE_KM_BLOCKED");
  }

  const range = (ranges || []).find((item) => item.active !== false
    && distance >= Number(item.min_distance_km)
    && distance <= Number(item.max_distance_km));
  if (!range) throw new Error("NO_DELIVERY_RANGE");
  return {
    allowed: true,
    uberAvailable: false,
    deliveryFee: Number(range.fee),
    code: "RANGE",
  };
}
