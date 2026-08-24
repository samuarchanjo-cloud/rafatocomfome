export const DELIVERY_ROUTING_FUNCTION = "delivery-routing";

async function routingError(error, fallbackMessage) {
  let responseBody = null;
  try {
    responseBody = typeof error?.context?.clone === "function"
      ? await error.context.clone().json()
      : null;
  } catch {
    responseBody = null;
  }
  const code = responseBody?.error || error?.code || "ROUTING_UNAVAILABLE";
  const message = responseBody?.message || error?.context?.message || error?.message || fallbackMessage;
  return Object.assign(new Error(message), { code });
}

async function invokeRouting(action, payload, client) {
  if (!client?.functions?.invoke) throw new Error("ROUTING_CLIENT_REQUIRED");
  const { data, error } = await client.functions.invoke(DELIVERY_ROUTING_FUNCTION, {
    body: { action, ...payload },
  });
  if (error) throw await routingError(error, "Não foi possível calcular a rota agora. Tente novamente.");
  if (data?.error) throw Object.assign(new Error(data.message || data.error), { code: data.error });
  return data;
}

export async function quoteDeliveryRoute(location, client) {
  return invokeRouting("quote", {
    location: {
      latitude: location?.latitude,
      longitude: location?.longitude,
      source: location?.source,
    },
  }, client);
}

export async function placeRoutedOrder(payload, client) {
  return invokeRouting("place_order", { order: payload }, client);
}
