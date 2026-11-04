import { createClient } from "npm:@supabase/supabase-js@2";
import { calculateRouteWithFallback, evaluateRouteQuote } from "../_shared/routing.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json; charset=utf-8",
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

function isGatewayVerifiedAnonymousJwt(bearer) {
  // verify_jwt must remain enabled: the gateway verifies the signature before
  // this handler uses the claims to distinguish an API credential from a session.
  const segments = bearer.split(".");
  if (segments.length !== 3 || segments.some(segment => !/^[A-Za-z0-9_-]+$/.test(segment))) return false;
  try {
    const claims = JSON.parse(atob(segments[1].replace(/-/g, "+").replace(/_/g, "/")));
    return claims.role === "anon" && claims.sub == null;
  } catch {
    return false;
  }
}

function validLocation(location) {
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);
  return ["gps", "address", "nominatim_exact", "nominatim_street"].includes(location?.source)
    && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

async function loadDeliveryConfiguration(admin) {
  const [{ data: settings, error: settingsError }, { data: ranges, error: rangesError }] = await Promise.all([
    admin.from("app_settings").select("*").eq("id", "global").single(),
    admin.from("delivery_fee_ranges").select("*").eq("active", true).order("min_distance_km"),
  ]);
  if (settingsError || rangesError) throw new Error("DELIVERY_NOT_CONFIGURED");
  return { settings, ranges: ranges || [] };
}

async function calculateServerRoute(location, settings) {
  if (!validLocation(location)) throw new Error("INVALID_LOCATION_SOURCE");
  const origin = {
    latitude: Number(settings.store_latitude),
    longitude: Number(settings.store_longitude),
  };
  const destination = {
    latitude: Number(location.latitude),
    longitude: Number(location.longitude),
  };
  return calculateRouteWithFallback(origin, destination, {
    apiKey: Deno.env.get("OPENROUTESERVICE_API_KEY"),
    onFallback(error) {
      console.warn("delivery-routing: usando Haversine após falha do provedor", error?.message || "unknown");
    },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (request.method !== "POST") return response({ error: "METHOD_NOT_ALLOWED", message: "Método não permitido." }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !serviceRoleKey || !anonKey) throw new Error("SERVER_NOT_CONFIGURED");
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const body = await request.json();
    const bearer = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
    let actorUserId = null;
    if (bearer !== anonKey && !isGatewayVerifiedAnonymousJwt(bearer)) {
      const authClient = createClient(supabaseUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${bearer}` } },
      });
      const { data: userData, error: userError } = await authClient.auth.getUser(bearer);
      if (userError || !userData.user) {
        return response({ error: "AUTH_REQUIRED", message: "Não foi possível validar sua sessão. Entre novamente na conta." }, 401);
      }
      actorUserId = userData.user.id;
    }

    if (body?.action === "quote") {
      const { settings, ranges } = await loadDeliveryConfiguration(admin);
      const route = await calculateServerRoute(body.location, settings);
      const quote = evaluateRouteQuote(route.distanceKm, ranges, settings);
      return response({
        distanceKm: route.distanceKm,
        durationMinutes: route.durationMinutes,
        routeSource: route.source,
        ...quote,
      });
    }

    const attempt = body?.attempt;
    if (body?.action === "recover_order" || attempt != null) {
      if (typeof attempt?.id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(attempt.id)
          || typeof attempt.secret !== "string" || !/^[a-f0-9]{64}$/.test(attempt.secret)) {
        return response({ error: "INVALID_CHECKOUT_ATTEMPT" }, 400);
      }
      const { data, error } = await admin.rpc("checkout_attempt_receipt", {
        p_id: attempt.id, p_secret: attempt.secret, p_actor: actorUserId,
        p_order: body.action === "place_order" ? body.order || {} : null,
      });
      if (error) throw error;
      if (data) return response(data);
      if (body.action === "recover_order") return response({ error: "CHECKOUT_RECEIPT_NOT_FOUND" }, 404);
    }

    if (body?.action === "place_order") {
      const order = body.order || {};
      let route = null;
      if (order.delivery_type === "entrega" && order.geocoding_source !== "postal_zone") {
        const { settings } = await loadDeliveryConfiguration(admin);
        route = await calculateServerRoute({
          latitude: order.latitude,
          longitude: order.longitude,
          source: order.location_source,
        }, settings);
      }
      const { data, error } = await admin.rpc(attempt ? "place_order_once" : "place_order_v4", {
        p_order: order,
        p_route: route ? {
          distance_km: route.distanceKm,
          duration_minutes: route.durationMinutes,
          source: route.source,
        } : {},
        ...(attempt ? { p_id: attempt.id, p_secret: attempt.secret, p_actor: actorUserId } : { p_actor_user_id: actorUserId }),
      });
      if (error) throw error;
      return response(data);
    }

    return response({ error: "INVALID_ACTION", message: "Operação inválida." }, 400);
  } catch (error) {
    const code = String(error?.message || "ROUTING_UNAVAILABLE").split(":")[0];
    const clientErrors = new Set([
      "INVALID_LOCATION_SOURCE", "INVALID_DELIVERY_MODE", "LOCATION_REQUIRED",
      "OUTSIDE_DELIVERY_AREA", "UBER_NOT_AVAILABLE", "NO_DELIVERY_RANGE",
      "DELIVERY_NOT_CONFIGURED", "BELOW_ONE_KM_BLOCKED", "DELIVERY_ZONE_NOT_FOUND",
      "STORE_CLOSED", "EMPTY_ORDER", "INVALID_CUSTOMER", "INVALID_ADDRESS",
      "INVALID_PAYMENT", "INVALID_DELIVERY_TYPE", "PRODUCT_UNAVAILABLE",
      "INVALID_LOCATION_ACCURACY", "CUSTOMER_ADDRESS_FORBIDDEN", "CUSTOMER_REQUIRED",
    ]);
    if (code === "CHECKOUT_ATTEMPT_CONFLICT") return response({ error: code }, 409);
    console.error("delivery-routing:", code);
    return response({ error: code, message: code }, clientErrors.has(code) ? 400 : 500);
  }
});
