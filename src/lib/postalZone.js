function postalCodeDigits(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 8);
}

const MATCH_TYPES = new Set(["exact"]);

export function createPostalZoneLocation(zone, requestedPostalCode) {
  const postalCode = postalCodeDigits(requestedPostalCode);
  const deliveryFee = Number(zone?.deliveryFee ?? zone?.delivery_fee);
  const matchType = zone?.matchType || zone?.match_type;
  const ruleId = String(zone?.id || "").trim();
  if (
    postalCode.length !== 8 ||
    !ruleId ||
    !MATCH_TYPES.has(matchType) ||
    !Number.isFinite(deliveryFee) ||
    deliveryFee < 0
  ) {
    return null;
  }

  return {
    source: "postal_zone",
    precision: "administrative",
    postalCode,
    ruleId,
    matchType,
    deliveryFee,
    km: null,
    centerKm: null,
  };
}
