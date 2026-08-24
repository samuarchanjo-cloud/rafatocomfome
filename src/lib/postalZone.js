function postalCodeDigits(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 8);
}

export function createPostalZoneLocation(zone, requestedPostalCode) {
  const postalCode = postalCodeDigits(requestedPostalCode);
  const zonePostalCode = postalCodeDigits(zone?.postalCode || zone?.postal_code);
  const deliveryFee = Number(zone?.deliveryFee ?? zone?.delivery_fee);
  if (
    postalCode.length !== 8 ||
    zonePostalCode !== postalCode ||
    !Number.isFinite(deliveryFee) ||
    deliveryFee < 0
  ) {
    return null;
  }

  return {
    source: "postal_zone",
    precision: "administrative",
    postalCode,
    deliveryFee,
    km: null,
    centerKm: null,
  };
}
