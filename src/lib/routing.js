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
  const status = error?.context?.status;
  const code = status === 401 ? "AUTH_REQUIRED" : responseBody?.error || error?.code || "ROUTING_UNAVAILABLE";
  const message = responseBody?.message || error?.context?.message || error?.message || fallbackMessage;
  return Object.assign(new Error(message), { code, status });
}

export async function checkoutSession(client, { expectedUserId } = {}) {
  const result = await client.auth.getSession();
  if (result.error) throw Object.assign(new Error("Não foi possível verificar sua sessão. Entre novamente na conta."), { code: "AUTH_REQUIRED" });
  let session = result.data?.session;
  if (session && Number(session.expires_at) * 1000 <= Date.now() + 30_000) {
    const refreshed = await client.auth.refreshSession();
    if (refreshed.error || !refreshed.data?.session) {
      throw Object.assign(new Error("Sua sessão expirou. Entre novamente para finalizar."), { code: "AUTH_REQUIRED" });
    }
    session = refreshed.data.session;
  }
  if (expectedUserId !== undefined && (session?.user?.id ?? null) !== expectedUserId) {
    throw Object.assign(new Error("Sua sessão mudou. Entre novamente na conta antes de finalizar."), { code: "AUTH_REQUIRED" });
  }
  return session;
}

async function invokeRouting(action, payload, client, options) {
  if (!client?.functions?.invoke) throw new Error("ROUTING_CLIENT_REQUIRED");
  // Do not retry a creation after a transport error: it may already be committed.
  const session = await checkoutSession(client, options);
  const { data, error } = await client.functions.invoke(DELIVERY_ROUTING_FUNCTION, {
    body: { action, ...payload },
    ...(session?.access_token ? { headers: { Authorization: `Bearer ${session.access_token}` } } : {}),
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

export async function placeRoutedOrder(payload, client, options) {
  return invokeRouting("place_order", { order: payload, attempt: options?.attempt }, client, options);
}

export async function recoverRoutedOrder(attempt, client, options) {
  return invokeRouting("recover_order", { attempt }, client, options);
}