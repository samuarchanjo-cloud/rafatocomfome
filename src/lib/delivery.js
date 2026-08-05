export function distanceInKm(origin, destination) {
  const earthRadiusKm = 6371;
  const toRad = (value) => (value * Math.PI) / 180;
  const latDiff = toRad(destination.latitude - origin.latitude);
  const lonDiff = toRad(destination.longitude - origin.longitude);
  const originLat = toRad(origin.latitude);
  const destinationLat = toRad(destination.latitude);
  const a =
    Math.sin(latDiff / 2) ** 2 +
    Math.cos(originLat) * Math.cos(destinationLat) * Math.sin(lonDiff / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function evaluateDelivery(distance, ranges, settings) {
  if (!Number.isFinite(distance)) {
    return { allowed: false, fee: 0, code: "LOCATION_REQUIRED", message: "Valide o endereço para calcular a entrega." };
  }

  const roundedDistance = Math.round(distance * 100) / 100;
  const maximum = Number(settings.maximum_delivery_distance_km);
  if (!Number.isFinite(maximum) || maximum <= 0) {
    return { allowed: false, fee: 0, code: "DELIVERY_NOT_CONFIGURED", message: "A área de entrega ainda não foi configurada." };
  }
  if (roundedDistance > maximum) {
    return { allowed: false, fee: 0, code: "OUTSIDE_AREA", message: `Endereço fora da área máxima de ${maximum.toFixed(2)} km.` };
  }

  if (roundedDistance < 1) {
    const behavior = settings.below_one_km_behavior;
    if (behavior === "free") return { allowed: true, fee: 0, code: "FREE", message: "Entrega grátis abaixo de 1 km." };
    if (behavior === "fixed") {
      const fee = Number(settings.below_one_km_fee);
      if (Number.isFinite(fee) && fee >= 0) return { allowed: true, fee, code: "FIXED", message: "Taxa fixa abaixo de 1 km." };
      return { allowed: false, fee: 0, code: "DELIVERY_NOT_CONFIGURED", message: "A taxa abaixo de 1 km ainda não foi definida." };
    }
    return { allowed: false, fee: 0, code: "BELOW_ONE_BLOCKED", message: "Pedidos abaixo de 1 km estão bloqueados para entrega." };
  }

  const range = (ranges || []).find(
    (item) =>
      item.active !== false &&
      roundedDistance >= Number(item.min_distance_km) &&
      roundedDistance <= Number(item.max_distance_km),
  );
  if (!range) {
    return { allowed: false, fee: 0, code: "NO_FEE_RANGE", message: "Não há uma faixa de entrega configurada para esta distância." };
  }
  return { allowed: true, fee: Number(range.fee) || 0, code: "RANGE", range, message: "Entrega disponível para o endereço informado." };
}

export function validateDeliveryRanges(ranges) {
  const active = ranges
    .filter((item) => item.active !== false)
    .map((item) => ({ ...item, min: Number(item.min_distance_km), max: Number(item.max_distance_km) }))
    .sort((first, second) => first.min - second.min);

  for (const range of active) {
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || !Number.isFinite(Number(range.fee))) {
      return "Preencha distâncias e taxa com valores válidos.";
    }
    if (range.min < 1) return "As distâncias abaixo de 1 km são configuradas na regra específica.";
    if (range.min > range.max) return "A distância mínima não pode ser maior que a máxima.";
    if (Number(range.fee) < 0) return "A taxa não pode ser negativa.";
  }
  for (let index = 1; index < active.length; index += 1) {
    const previous = active[index - 1];
    const current = active[index];
    if (current.min <= previous.max) return "As faixas ativas não podem se sobrepor.";
    if (Math.round((current.min - previous.max) * 100) / 100 !== 0.01) {
      return `Existe uma lacuna entre ${previous.max.toFixed(2)} km e ${current.min.toFixed(2)} km.`;
    }
  }
  return "";
}
