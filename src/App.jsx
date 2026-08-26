import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Bike,
  CheckCircle2,
  CreditCard,
  Home,
  Lock,
  MapPin,
  MessageCircle,
  Minus,
  Navigation,
  PackageCheck,
  Plus,
  Search,
  ShoppingCart,
  Store,
  TriangleAlert,
  Trash2,
  UserRound,
  Wallet,
} from "lucide-react";
import AdminPanel from "./components/AdminPanel";
import CustomerAccount from "./components/CustomerAccount";
import { ProductDetails, Recommendations } from "./components/CheckoutExtras";
import { FALLBACK_BUSINESS_HOURS, FALLBACK_CATEGORIES, PUBLIC_FALLBACKS } from "./menuData";
import {
  composeDeliveryAddress,
  formatPostalCode,
  lookupPostalCode,
  postalCodeDigits,
  reverseGeocodeCoordinates,
  validateDeliveryPostalAddress,
  validateDeliveryAddressFields,
} from "./lib/address";
import { getBusinessStatus } from "./lib/businessHours";
import { evaluateOrderDelivery } from "./lib/delivery";
import { locateDeliveryAddress } from "./lib/geocodingProvider";
import { isTrustedDeliveryLocation, requestDeviceGps } from "./lib/location";
import { checkoutDraft, rebuildCartFromOrder, recommendProducts, savedAddressToCheckout } from "./lib/customer";
import { createPostalZoneLocation } from "./lib/postalZone";
import {
  checkIsAdmin,
  deleteCustomerAddress,
  quoteDeliveryRoute,
  resolveDeliveryArea,
  getSession,
  loadCustomerAccount,
  loadStoreData,
  onAuthChange,
  placeOrder,
  saveCustomerAddress,
  saveCustomerProfile,
  signIn,
  signUpCustomer,
  signOut,
  subscribeToStoreChanges,
} from "./lib/api";

const STORAGE_KEY = "rafa-cart";
const CHECKOUT_STORAGE_KEY = "rafa-checkout-draft-v2";
const DELIVERY_ADDRESS_FIELDS = new Set(["postalCode", "street", "number", "complement", "neighborhood", "city", "state", "reference"]);
const EMPTY_CHECKOUT = {
  name: "", phone: "", postalCode: "", street: "", number: "", complement: "",
  neighborhood: "", city: "", state: "", reference: "", deliveryType: "entrega",
  deliveryMode: "own_delivery", payment: "pix", needsChange: false, changeFor: "", notes: "",
  locationFlow: null, saveAddress: false, accountChoice: "guest", accountEmail: "",
};
const EMPTY_STORE = {
  products: [],
  categories: FALLBACK_CATEGORIES,
  businessHours: FALLBACK_BUSINESS_HOURS,
  deliveryRanges: [],
  settings: PUBLIC_FALLBACKS,
  setupWarnings: [],
};

const paymentLabels = {
  pix: "Pix",
  dinheiro: "Dinheiro",
  credito: "Cartão de crédito",
  debito: "Cartão de débito",
};

function readCart() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function readCheckoutDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(CHECKOUT_STORAGE_KEY));
    return draft && typeof draft === "object" ? draft : {};
  } catch {
    return {};
  }
}

function money(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);
}

function moneyFromInput(value) {
  const normalized = String(value || "").trim().replace(/\s/g, "").replace(/^R\$/i, "").replace(/\./g, "").replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? money(number) : value;
}

function isSoldOut(product) {
  return product.status === "Esgotado";
}

function publicProducts(products) {
  return products.filter((product) => product.visible !== false);
}

function friendlyOrderError(error) {
  const message = `${error?.message || ""} ${error?.details || ""}`;
  if (message.includes("STORE_CLOSED")) return "O estabelecimento está fechado. O pedido não foi salvo nem enviado.";
  if (message.includes("LOCATION_REQUIRED")) return "Valide o endereço de entrega antes de finalizar o pedido.";
  if (message.includes("INVALID_LOCATION_SOURCE")) return "Confirme o local de entrega antes de finalizar.";
  if (message.includes("INVALID_LOCATION_ACCURACY")) return "A localização do aparelho não teve precisão suficiente. Tente novamente.";
  if (message.includes("INVALID_LOCATION_UNCERTAINTY")) return "Não foi possível validar este endereço. Revise os dados e tente novamente.";
  if (message.includes("DELIVERY_ZONE_NOT_FOUND")) return "Este endereço ainda não está disponível para cálculo automático de entrega.";
  if (message.includes("MAP_PIN_CONFIRMATION_REQUIRED")) return "Confirme o local de entrega no mapa antes de finalizar.";
  if (message.includes("ADDRESS_REQUIRES_CONFIRMATION")) return "Não conseguimos confirmar com segurança se este endereço está dentro da área de entrega.";
  if (message.includes("OUTSIDE_DELIVERY_AREA")) return "Este endereço está fora da nossa área de entrega.";
  if (message.includes("UBER_NOT_AVAILABLE")) return "Uber Entrega só fica disponível acima do limite da entrega própria.";
  if (message.includes("INVALID_ROUTE_DISTANCE") || message.includes("INVALID_ROUTE_DURATION")) return "Não foi possível validar a rota de entrega. Calcule novamente.";
  if (message.includes("BELOW_ONE_KM_BLOCKED")) return "Pedidos abaixo de 1 km estão bloqueados para entrega.";
  if (message.includes("DELIVERY_NOT_CONFIGURED") || message.includes("NO_DELIVERY_RANGE")) return "Não há uma taxa configurada para esta distância.";
  if (message.includes("PRODUCT_UNAVAILABLE")) return "Um produto do carrinho ficou indisponível. Revise o pedido.";
  if (message.includes("CUSTOMER_ADDRESS_FORBIDDEN")) return "Este endereço salvo não pertence à sua conta ou foi alterado. Selecione-o novamente.";
  if (message.includes("CUSTOMER_REQUIRED")) return "Entre novamente na sua conta para vincular este endereço.";
  if (message.includes("NOT_ADMIN")) return "Este usuário não está autorizado como administrador.";
  return error?.message || "Não foi possível finalizar o pedido.";
}

function App() {
  const initialDraftRef = useRef(readCheckoutDraft());
  const [store, setStore] = useState(EMPTY_STORE);
  const [loadingStore, setLoadingStore] = useState(true);
  const [cart, setCart] = useState(readCart);
  const [view, setView] = useState(() => initialDraftRef.current.view || "home");
  const [activeCategory, setActiveCategory] = useState(null);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [adminAuthorized, setAdminAuthorized] = useState(false);
  const [adminAccessError, setAdminAccessError] = useState("");
  const [checkout, setCheckout] = useState(() => ({ ...EMPTY_CHECKOUT, ...(initialDraftRef.current.checkout || {}) }));
  const [deliveryLocation, setDeliveryLocation] = useState(() => initialDraftRef.current.deliveryLocation || null);
  const [postalCodeStatus, setPostalCodeStatus] = useState({ type: "idle", message: "" });
  const [addressValidationStatus, setAddressValidationStatus] = useState({ type: "idle", message: "" });
  const [validatingAddress, setValidatingAddress] = useState(false);
  const [pixCopyStatus, setPixCopyStatus] = useState("");
  const [submittingOrder, setSubmittingOrder] = useState(false);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [account, setAccount] = useState({ profile: null, addresses: [], orders: [], setupRequired: false });
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountPassword, setAccountPassword] = useState("");
  const geocodingAbortRef = useRef(null);

  const showNotice = useCallback((message, type = "info") => {
    setNotice({ message, type });
    window.setTimeout(() => setNotice(null), 4200);
  }, []);

  const reloadStore = useCallback(async () => {
    try {
      const data = await loadStoreData();
      setStore(data);
      return data;
    } catch (error) {
      console.error("Erro ao carregar o Supabase:", error);
      showNotice("Não foi possível carregar os dados do Supabase.", "error");
      throw error;
    } finally {
      setLoadingStore(false);
    }
  }, [showNotice]);

  const reloadAccount = useCallback(async () => {
    if (!session) {
      setAccount({ profile: null, addresses: [], orders: [], setupRequired: false });
      return null;
    }
    setAccountLoading(true);
    try {
      const data = await loadCustomerAccount();
      setAccount(data);
      setCheckout((current) => ({
        ...current,
        name: current.name || data.profile?.name || session.user?.user_metadata?.name || "",
        phone: current.phone || data.profile?.phone || session.user?.user_metadata?.phone || "",
        accountEmail: current.accountEmail || data.profile?.email || session.user?.email || "",
      }));
      return data;
    } catch (error) {
      if (error.code !== "PGRST205") showNotice(error.message, "error");
      return null;
    } finally {
      setAccountLoading(false);
    }
  }, [session, showNotice]);

  useEffect(() => {
    reloadStore().catch(() => {});
    const stopAuth = onAuthChange(setSession);
    getSession().then(setSession).catch(() => setAuthLoading(false));
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => {
      stopAuth();
      window.clearInterval(timer);
    };
  }, [reloadStore]);

  useEffect(() => {
    let active = true;
    if (!session) {
      setAdminAuthorized(false);
      setAdminAccessError("");
      setAuthLoading(false);
      return undefined;
    }
    setAuthLoading(true);
    checkIsAdmin()
      .then((authorized) => {
        if (!active) return;
        setAdminAuthorized(authorized);
        setAdminAccessError(authorized ? "" : "Este usuário não está na lista app_admins.");
      })
      .catch((error) => {
        if (!active) return;
        setAdminAuthorized(false);
        setAdminAccessError(error.code === "PGRST202" ? "Execute a migração SQL para ativar o acesso seguro." : error.message);
      })
      .finally(() => active && setAuthLoading(false));
    return () => {
      active = false;
    };
  }, [session]);

  useEffect(() => { reloadAccount().catch(() => {}); }, [reloadAccount]);

  useEffect(() => {
    let debounce;
    const unsubscribe = subscribeToStoreChanges(() => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => reloadStore().catch(() => {}), 250);
    });
    return () => {
      window.clearTimeout(debounce);
      unsubscribe();
    };
  }, [reloadStore]);

  useEffect(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(cart)), [cart]);

  useEffect(() => {
    localStorage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(checkoutDraft(checkout, deliveryLocation, view)));
  }, [checkout, deliveryLocation, view]);

  useEffect(() => {
    if (checkout.locationFlow !== "address") {
      setPostalCodeStatus({ type: "idle", message: "" });
      return undefined;
    }
    const postalCode = postalCodeDigits(checkout.postalCode);
    if (postalCode.length !== 8) {
      setPostalCodeStatus({ type: "idle", message: "" });
      return undefined;
    }

    const controller = new AbortController();
    setPostalCodeStatus({ type: "loading", message: "Consultando CEP..." });
    lookupPostalCode(postalCode, { signal: controller.signal })
      .then((address) => {
        setCheckout((current) => {
          if (postalCodeDigits(current.postalCode) !== postalCode) return current;
          return {
            ...current,
            postalCode: address.postalCode,
            street: address.street,
            neighborhood: address.neighborhood,
            city: address.city,
            state: address.state,
          };
        });
        setDeliveryLocation(null);
        setAddressValidationStatus({ type: "idle", message: "" });
        setPostalCodeStatus({ type: "success", message: "CEP encontrado. Confira e complete o endereço." });
      })
      .catch((error) => {
        if (error.name === "AbortError") return;
        setPostalCodeStatus({ type: "error", message: error.message });
      });
    return () => controller.abort();
  }, [checkout.postalCode, checkout.locationFlow]);

  const status = getBusinessStatus(store.businessHours, now, store.settings.timezone);
  const visibleProducts = useMemo(() => publicProducts(store.products), [store.products]);
  const visibleCategories = useMemo(() => store.categories.filter((category) => category.active !== false), [store.categories]);
  const cartLines = useMemo(
    () => cart.map((item) => {
      const product = visibleProducts.find((candidate) => candidate.id === item.id);
      return product ? { ...item, product, lineTotal: Number(product.price) * item.qty } : null;
    }).filter(Boolean),
    [cart, visibleProducts],
  );
  const cartCount = cart.reduce((sum, item) => sum + item.qty, 0);
  const subtotal = cartLines.reduce((sum, item) => sum + item.lineTotal, 0);
  const deliveryAssessment = evaluateOrderDelivery(
    checkout.deliveryType,
    deliveryLocation,
    store.deliveryRanges,
    store.settings,
  );
  const uberSelected = checkout.deliveryType === "entrega"
    && checkout.deliveryMode === "uber"
    && deliveryAssessment.uberAvailable;
  const deliveryAllowed = deliveryAssessment.allowed || uberSelected;
  const deliveryFee = deliveryAssessment.allowed ? deliveryAssessment.fee : 0;
  const isCardPayment = ["credito", "debito"].includes(checkout.payment);
  const cardFee = isCardPayment ? (subtotal + deliveryFee) * (Number(store.settings.card_fee_percent) || 0) / 100 : 0;
  const total = subtotal + deliveryFee + cardFee;
  const currentCategory = visibleCategories.find((category) => category.id === activeCategory);
  const filteredProducts = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("pt-BR");
    if (!term) return [];
    return visibleProducts.filter((product) =>
      product.name.toLocaleLowerCase("pt-BR").includes(term) ||
      product.description?.toLocaleLowerCase("pt-BR").includes(term) ||
      visibleCategories.find((category) => category.id === product.category)?.name.toLocaleLowerCase("pt-BR").includes(term),
    );
  }, [search, visibleProducts, visibleCategories]);
  const recommendations = useMemo(
    () => recommendProducts(visibleProducts, cart, { storeOpen: status.open }),
    [visibleProducts, cart, status.open],
  );

  function openCategory(categoryId) {
    setActiveCategory(categoryId);
    setSearch("");
    setView("category");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function addToCart(product, quantity = 1) {
    if (isSoldOut(product)) return showNotice("Produto esgotado não pode ser adicionado.", "error");
    const safeQuantity = Math.max(1, Math.min(50, Number(quantity) || 1));
    setCart((current) => {
      const existing = current.find((item) => item.id === product.id);
      return existing
        ? current.map((item) => item.id === product.id ? { ...item, qty: Math.min(50, item.qty + safeQuantity) } : item)
        : [...current, { id: product.id, qty: safeQuantity }];
    });
    setSelectedProduct(null);
    showNotice("Produto adicionado ao carrinho.", "success");
  }

  function updateQty(productId, delta) {
    setCart((current) => current.map((item) => item.id === productId ? { ...item, qty: Math.max(0, item.qty + delta) } : item).filter((item) => item.qty > 0));
  }

  function setCheckoutField(field, value) {
    const changesValidatedManualAddress = DELIVERY_ADDRESS_FIELDS.has(field) && checkout.locationFlow !== "gps";
    if (changesValidatedManualAddress || field === "deliveryType") {
      geocodingAbortRef.current?.abort();
      setDeliveryLocation(null);
      setAddressValidationStatus({ type: "idle", message: "" });
    }
    setCheckout((current) => {
      const next = { ...current, [field]: value };
      if (changesValidatedManualAddress || field === "deliveryType") next.deliveryMode = "own_delivery";
      if (field === "deliveryType") Object.assign(next, { locationFlow: null, customerAddressId: null });
      if (field === "locationFlow") Object.assign(next, { customerAddressId: null, deliveryMode: "own_delivery" });
      if (field === "payment" && value !== "dinheiro") Object.assign(next, { needsChange: false, changeFor: "" });
      if (field === "needsChange" && !value) next.changeFor = "";
      return next;
    });
  }

  async function resolveDeliveryCoordinates(coordinates) {
    const route = await quoteDeliveryRoute(coordinates);
    const location = {
      ...coordinates,
      km: Number(route.distanceKm),
      routeSource: route.routeSource,
      routeDurationMinutes: route.durationMinutes,
    };
    const assessment = evaluateOrderDelivery("entrega", location, store.deliveryRanges, store.settings);
    return { location, assessment };
  }

  async function acceptResolvedLocation(coordinates) {
    const { location, assessment } = await resolveDeliveryCoordinates(coordinates);
    setDeliveryLocation(location);
    setCheckout((current) => ({ ...current, deliveryMode: "own_delivery" }));
    setAddressValidationStatus({
      type: assessment.allowed ? "success" : "outside",
      message: assessment.allowed ? "Local de entrega confirmado." : "Este endereço fica fora da nossa área de entrega própria.",
    });
  }

  function chooseManualAddress({ preserveFields = false } = {}) {
    geocodingAbortRef.current?.abort();
    setDeliveryLocation(null);
    setAddressValidationStatus({ type: "idle", message: "" });
    setCheckout((current) => ({
      ...current,
      ...(preserveFields ? {} : { postalCode: "", street: "", number: "", complement: "", neighborhood: "", city: "", state: "", reference: "" }),
      locationFlow: "address",
      customerAddressId: null,
      deliveryMode: "own_delivery",
    }));
  }

  async function useDeviceLocation() {
    if (gpsLoading) return;
    geocodingAbortRef.current?.abort();
    setGpsLoading(true);
    setDeliveryLocation(null);
    setCheckout((current) => ({ ...current, locationFlow: "gps", customerAddressId: null, deliveryMode: "own_delivery" }));
    setAddressValidationStatus({ type: "loading", message: "Obtendo a localização precisa do aparelho..." });
    try {
      const gps = await requestDeviceGps({ confirmed: true });
      await acceptResolvedLocation({ ...gps, locationSource: "gps", geocodingSource: null });
      try {
        const resolved = await reverseGeocodeCoordinates(gps);
        setCheckout((current) => current.locationFlow !== "gps" ? current : ({
          ...current,
          street: resolved.street || current.street,
          neighborhood: resolved.neighborhood || current.neighborhood,
          city: resolved.city || current.city,
          state: resolved.state || current.state,
          postalCode: resolved.postalCode || current.postalCode,
        }));
        setDeliveryLocation((current) => current ? { ...current, geocodingSource: resolved.geocodingSource } : current);
      } catch (error) {
        if (error.name !== "AbortError") console.warn("Reverse geocoding indisponível:", error.message);
      }
    } catch (error) {
      setDeliveryLocation(null);
      setAddressValidationStatus({
        type: "gps-error",
        message: error.code === "GPS_INACCURATE"
          ? error.message
          : "Não conseguimos acessar sua localização. Informe o endereço manualmente.",
      });
    } finally {
      setGpsLoading(false);
    }
  }

  async function useSavedAddress(address) {
    const fields = savedAddressToCheckout(address);
    setCheckout((current) => ({
      ...current, ...fields, locationFlow: "saved", customerAddressId: address.id,
      deliveryMode: "own_delivery", saveAddress: false,
    }));
    const latitude = Number(address.latitude);
    const longitude = Number(address.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      chooseManualAddress({ preserveFields: true });
      showNotice("Este endereço salvo precisa ser validado novamente.", "info");
      return;
    }
    setAddressValidationStatus({ type: "loading", message: "Recalculando a entrega para o endereço salvo..." });
    try {
      const source = address.location_source === "gps" ? "gps" : (address.geocoding_source || "nominatim_exact");
      await acceptResolvedLocation({
        latitude, longitude, source, precision: source === "nominatim_street" ? "street" : "exact",
        accuracy: address.location_accuracy, locationSource: address.location_source || "address",
        geocodingSource: address.geocoding_source || null,
      });
    } catch (error) {
      setDeliveryLocation(null);
      setAddressValidationStatus({ type: "error", message: error.message });
    }
  }

  function editSavedAddress(address) {
    geocodingAbortRef.current?.abort();
    setDeliveryLocation(null);
    setAddressValidationStatus({ type: "idle", message: "" });
    setCheckout((current) => ({
      ...current,
      ...savedAddressToCheckout(address),
      locationFlow: "address",
      customerAddressId: address.id,
      deliveryMode: "own_delivery",
      saveAddress: true,
    }));
  }

  async function validateDeliveryAddress() {
    if (validatingAddress) return;
    const validationMessage = validateDeliveryAddressFields(checkout);
    if (validationMessage) {
      setAddressValidationStatus({ type: "error", message: validationMessage });
      return;
    }

    geocodingAbortRef.current?.abort();
    const controller = new AbortController();
    geocodingAbortRef.current = controller;
    setDeliveryLocation(null);
    setValidatingAddress(true);
    setAddressValidationStatus({ type: "loading", message: "Localizando o endereço..." });
    try {
      const postalAddress = await validateDeliveryPostalAddress(checkout, { signal: controller.signal });
      setAddressValidationStatus({ type: "loading", message: "Verificando disponibilidade da entrega..." });
      const zone = await resolveDeliveryArea(checkout.postalCode, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const administrativeLocation = createPostalZoneLocation(zone, checkout.postalCode);
      if (administrativeLocation) {
        setDeliveryLocation({ ...administrativeLocation, locationSource: "address", geocodingSource: "postal_zone" });
        setAddressValidationStatus({ type: "success", message: "Entrega disponível para o endereço informado." });
        return;
      }

      setAddressValidationStatus({ type: "loading", message: "Localizando o endereço..." });
      const maximumDeliveryDistanceKm = Number(store.settings.maximum_delivery_distance_km);
      const coordinates = await locateDeliveryAddress(checkout, {
        signal: controller.signal,
        postalAddress,
        origin: {
          latitude: Number(store.settings.store_latitude),
          longitude: Number(store.settings.store_longitude),
        },
        maximumCandidateDistanceKm: Number.isFinite(maximumDeliveryDistanceKm)
          ? Math.max(maximumDeliveryDistanceKm * 2, maximumDeliveryDistanceKm + 2)
          : undefined,
      });
      if (!isTrustedDeliveryLocation(coordinates)) {
        setAddressValidationStatus({ type: "error", message: "O endereço não pôde ser localizado com precisão." });
        return;
      }
      setAddressValidationStatus({ type: "loading", message: "Calculando a rota de entrega..." });
      await acceptResolvedLocation({
        ...coordinates,
        locationSource: "address",
        geocodingSource: coordinates.source,
      });
    } catch (error) {
      if (error.name === "AbortError") return;
      if (error.code === "ADDRESS_NOT_PRECISE") {
        setAddressValidationStatus({
          type: "unavailable",
          message: "Este endereço ainda não está disponível para entrega.",
        });
        return;
      }
      setAddressValidationStatus({
        type: "error",
        message: error.message || "Não foi possível validar o endereço. Revise os dados e tente novamente.",
      });
    } finally {
      if (geocodingAbortRef.current === controller) {
        geocodingAbortRef.current = null;
        setValidatingAddress(false);
      }
    }
  }

  function changeDeliveryLocation() {
    geocodingAbortRef.current?.abort();
    setDeliveryLocation(null);
    setAddressValidationStatus({ type: "idle", message: "" });
    setCheckout((current) => ({
      ...current,
      locationFlow: null,
      customerAddressId: null,
      deliveryMode: "own_delivery",
    }));
  }

  function reviewDeliveryAddress() {
    geocodingAbortRef.current?.abort();
    setDeliveryLocation(null);
    setAddressValidationStatus({ type: "idle", message: "" });
    setCheckout((current) => ({ ...current, locationFlow: "address", customerAddressId: null, deliveryMode: "own_delivery" }));
    window.setTimeout(() => document.getElementById("delivery-number")?.focus(), 0);
  }

  async function copyPixKey() {
    try {
      await navigator.clipboard.writeText(store.settings.pix_key);
      setPixCopyStatus("Chave Pix copiada");
    } catch {
      setPixCopyStatus("Não foi possível copiar. Toque e segure na chave.");
    }
    window.setTimeout(() => setPixCopyStatus(""), 2400);
  }

  function buildWhatsappMessage(order) {
    const itemLines = order.items.map((item) => `• ${item.quantity}x ${item.name}`).join("\n");
    const paymentLines = checkout.payment === "dinheiro"
      ? ["Pagamento: Dinheiro", checkout.needsChange ? `Troco para: ${moneyFromInput(checkout.changeFor)}` : ""]
      : [`💳 ${paymentLabels[checkout.payment]}`];
    const uberLines = order.delivery_mode === "uber"
      ? [
          "🚗 MÉTODO DE ENTREGA",
          "Uber solicitado pelo cliente",
          "Cliente irá solicitar o Uber para retirada na loja.",
          "📍 DESTINO INFORMADO",
          composeDeliveryAddress(checkout),
          order.distance_km != null ? `Distância estimada da rota: ${Number(order.distance_km).toFixed(2)} km` : "",
          "Taxa da loja: R$ 0,00",
          "Uber pago separadamente pelo cliente.",
        ]
      : [];
    return [
      "🍔 NOVO PEDIDO",
      `Código: ${String(order.id).slice(0, 8)}`,
      `👤 ${checkout.name}`,
      `📞 ${checkout.phone}`,
      order.delivery_mode !== "uber" ? `📍 ${checkout.deliveryType === "retirada" ? "Retirada no local" : composeDeliveryAddress(checkout)}` : "",
      order.delivery_mode !== "uber" && checkout.deliveryType === "entrega" && order.distance_km != null ? `Distância da rota: ${Number(order.distance_km).toFixed(2)} km` : "",
      ...uberLines,
      "🛒 Itens",
      itemLines,
      `Subtotal: ${money(order.subtotal)}`,
      `${order.delivery_mode === "uber" ? "Entrega da loja" : "Taxa de entrega"}: ${money(order.delivery_fee)}`,
      Number(order.card_fee) > 0 ? `Taxa do cartão: ${money(order.card_fee)}` : "",
      `💰 Total: ${money(order.total)}`,
      ...paymentLines,
      checkout.notes ? `📝 ${checkout.notes}` : "📝 Sem observação",
    ].filter(Boolean).join("\n");
  }

  function customerAddressPayload() {
    return {
      id: checkout.customerAddressId || undefined,
      label: "Casa",
      street: checkout.street,
      number: checkout.number,
      complement: checkout.complement,
      reference: checkout.reference,
      neighborhood: checkout.neighborhood,
      city: checkout.city,
      state: checkout.state,
      postcode: checkout.postalCode,
      latitude: deliveryLocation?.latitude,
      longitude: deliveryLocation?.longitude,
      location_source: deliveryLocation?.locationSource || (checkout.locationFlow === "gps" ? "gps" : "address"),
      location_accuracy: deliveryLocation?.accuracy ?? null,
      geocoding_source: deliveryLocation?.geocodingSource || (deliveryLocation?.source === "gps" ? null : deliveryLocation?.source),
      is_default: true,
    };
  }

  async function prepareCustomerForOrder() {
    let activeSession = session;
    if (!activeSession && checkout.accountChoice === "save") {
      if (!checkout.accountEmail.trim() || accountPassword.length < 6) {
        throw new Error("Informe um e-mail válido e uma senha com pelo menos 6 caracteres.");
      }
      const result = await signUpCustomer({
        email: checkout.accountEmail,
        password: accountPassword,
        name: checkout.name,
        phone: checkout.phone,
      });
      activeSession = result.session;
      if (!activeSession) {
        showNotice("Conta criada aguardando confirmação de e-mail. Este pedido seguirá como visitante.", "info");
        return null;
      }
      setSession(activeSession);
      await saveCustomerProfile({ name: checkout.name, phone: checkout.phone, email: checkout.accountEmail });
    }
    if (!activeSession) return null;

    if (!account.profile) {
      await saveCustomerProfile({
        name: checkout.name,
        phone: checkout.phone,
        email: activeSession.user.email,
      });
    }
    if (checkout.deliveryType === "entrega" && (checkout.saveAddress || checkout.accountChoice === "save")) {
      const saved = await saveCustomerAddress(customerAddressPayload());
      setCheckout((current) => ({ ...current, customerAddressId: saved.id }));
      return saved.id;
    }
    return checkout.customerAddressId || null;
  }

  async function finishOrder(event) {
    event.preventDefault();
    if (submittingOrder) return;
    const freshStatus = getBusinessStatus(store.businessHours, new Date(), store.settings.timezone);
    if (!freshStatus.open) {
      showNotice(`Estamos fechados. Próxima abertura: ${freshStatus.nextLabel}.`, "error");
      return;
    }
    if (!cartLines.length) return showNotice("Adicione pelo menos um produto ao carrinho.", "error");
    const addressValidationMessage = checkout.deliveryType === "entrega"
      ? checkout.locationFlow === "gps"
        ? (!checkout.street.trim() ? "Informe a rua do endereço de entrega." : !checkout.number.trim() ? "Informe o número do endereço de entrega." : "")
        : validateDeliveryAddressFields(checkout)
      : "";
    if (addressValidationMessage) return showNotice(addressValidationMessage, "error");
    if (checkout.deliveryType === "entrega" && !isTrustedDeliveryLocation(deliveryLocation)) {
      return showNotice("Confirme o local de entrega antes de finalizar.", "error");
    }
    if (checkout.deliveryType === "entrega" && !deliveryAllowed) return showNotice(deliveryAssessment.message, "error");
    if (checkout.payment === "dinheiro" && checkout.needsChange && !checkout.changeFor.trim()) return showNotice("Informe para quanto precisa de troco.", "error");

    setSubmittingOrder(true);
    try {
      const customerAddressId = await prepareCustomerForOrder();
      const order = await placeOrder({
        customer_name: checkout.name,
        customer_phone: checkout.phone,
        address: checkout.deliveryType === "entrega" ? composeDeliveryAddress(checkout) : null,
        reference: checkout.reference || null,
        delivery_type: checkout.deliveryType,
        delivery_mode: checkout.deliveryType === "entrega" ? checkout.deliveryMode : null,
        payment_method: checkout.payment,
        needs_change: checkout.needsChange,
        change_for: checkout.changeFor || null,
        notes: checkout.notes || null,
        customer_address_id: customerAddressId,
        street: checkout.deliveryType === "entrega" ? checkout.street : null,
        number: checkout.deliveryType === "entrega" ? checkout.number : null,
        complement: checkout.deliveryType === "entrega" ? checkout.complement || null : null,
        neighborhood: checkout.deliveryType === "entrega" ? checkout.neighborhood || null : null,
        city: checkout.deliveryType === "entrega" ? checkout.city || null : null,
        state: checkout.deliveryType === "entrega" ? checkout.state || null : null,
        latitude: checkout.deliveryType === "entrega" ? deliveryLocation?.latitude : null,
        longitude: checkout.deliveryType === "entrega" ? deliveryLocation?.longitude : null,
        location_source: checkout.deliveryType === "entrega" ? (deliveryLocation?.locationSource || (checkout.locationFlow === "gps" ? "gps" : "address")) : null,
        geocoding_source: checkout.deliveryType === "entrega" ? (deliveryLocation?.geocodingSource || (deliveryLocation?.source === "gps" ? null : deliveryLocation?.source)) : null,
        postal_code: checkout.deliveryType === "entrega" ? postalCodeDigits(checkout.postalCode) : null,
        location_accuracy_m: checkout.deliveryType === "entrega" ? deliveryLocation?.accuracy ?? null : null,
        location_uncertainty_m: null,
        items: cartLines.map((item) => ({ product_id: item.id, quantity: item.qty })),
      });
      const url = `https://wa.me/${store.settings.whatsapp_number}?text=${encodeURIComponent(buildWhatsappMessage(order))}`;
      setCart([]);
      localStorage.removeItem(CHECKOUT_STORAGE_KEY);
      setCheckout(EMPTY_CHECKOUT);
      setDeliveryLocation(null);
      setAccountPassword("");
      showNotice("Pedido salvo. Abrindo o WhatsApp...", "success");
      window.location.assign(url);
    } catch (error) {
      console.error("Erro ao finalizar pedido:", error);
      showNotice(friendlyOrderError(error), "error");
      await reloadStore().catch(() => {});
    } finally {
      setSubmittingOrder(false);
    }
  }

  async function loginCustomer(email, password) {
    try {
      const nextSession = await signIn(email, password);
      setSession(nextSession);
      showNotice("Conta acessada com sucesso.", "success");
    } catch (error) {
      showNotice(error.message === "Invalid login credentials" ? "E-mail ou senha inválidos." : error.message, "error");
      throw error;
    }
  }

  async function saveProfileFromAccount(profile) {
    try { await saveCustomerProfile(profile); await reloadAccount(); showNotice("Perfil salvo.", "success"); }
    catch (error) { showNotice(error.message, "error"); throw error; }
  }

  async function saveAddressFromAccount(address) {
    try { await saveCustomerAddress(address); await reloadAccount(); showNotice("Endereço salvo.", "success"); }
    catch (error) { showNotice(error.message, "error"); throw error; }
  }

  async function removeAddressFromAccount(addressId) {
    try { await deleteCustomerAddress(addressId); await reloadAccount(); showNotice("Endereço removido.", "success"); }
    catch (error) { showNotice(error.message, "error"); }
  }

  function repeatOrder(order) {
    const rebuilt = rebuildCartFromOrder(order, visibleProducts);
    if (!rebuilt.cart.length) return showNotice("Os itens deste pedido não estão disponíveis no momento.", "error");
    setCart(rebuilt.cart);
    setView("cart");
    showNotice(
      rebuilt.unavailable.length
        ? `Carrinho atualizado. Itens indisponíveis ignorados: ${rebuilt.unavailable.join(", ")}.`
        : "Pedido reconstruído com preços atuais. Revise o carrinho.",
      rebuilt.unavailable.length ? "info" : "success",
    );
  }

  async function logoutAdmin() {
    try { await signOut(); setSession(null); showNotice("Sessão encerrada."); }
    catch (error) { showNotice(error.message, "error"); }
  }

  return (
    <div className={view === "admin" ? "app-shell admin-shell" : "app-shell"}>
      <header className="topbar">
        <button className="brand-button" onClick={() => setView("home")} aria-label="Início"><img src={store.settings.brand_logo_url} alt={store.settings.store_name} /></button>
        <div className="store-chip"><span className={status.open ? "pulse open" : "pulse"} /><div><strong>{status.label}</strong><small>{status.detail}</small></div></div>
        <button className="account-button" onClick={() => setView("account")} aria-label="Minha conta"><UserRound size={21} />{session && <span className="session-dot" />}</button>
        <button className="cart-button" onClick={() => setView("cart")} aria-label="Abrir carrinho"><ShoppingCart size={22} />{cartCount > 0 && <span>{cartCount}</span>}</button>
      </header>

      <main>
        {view !== "admin" && <section className="search-wrap"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar produtos" aria-label="Buscar produtos" /></section>}
        {notice && <div className={`notice ${notice.type}`}>{notice.message}</div>}
        {loadingStore && <div className="notice">Carregando cardápio...</div>}
        {!status.open && view !== "admin" && <ClosedNotice status={status} />}

        {search.trim() && view !== "admin" && <ProductList title="Resultado da busca" products={filteredProducts} onAdd={addToCart} onBack={() => setSearch("")} />}

        {!search.trim() && view === "home" && <><section className="hero"><img src={store.settings.brand_hero_url} alt={`Banner ${store.settings.store_name}`} /></section><section className="category-section"><div className="section-title"><h1>Categorias</h1><span>Escolha sua fome</span></div><div className="category-stack">{visibleCategories.map((category) => <button className="category-banner" key={category.id} type="button" aria-label={`Abrir ${category.name}`} onClick={() => openCategory(category.id)}><img src={category.banner_url} alt={category.name} /></button>)}</div></section></>}

        {!search.trim() && view === "category" && <ProductList title={currentCategory?.name || "Produtos"} subtitle={currentCategory?.description} products={visibleProducts.filter((product) => product.category === activeCategory)} onAdd={addToCart} onBack={() => setView("home")} />}

        {!search.trim() && view === "cart" && <CartView cartLines={cartLines} subtotal={subtotal} deliveryFee={deliveryFee} cardFee={cardFee} isCardPayment={isCardPayment} total={total} checkout={checkout} status={status} recommendations={recommendations} onOpenRecommendation={setSelectedProduct} onQty={updateQty} onRemove={(id) => setCart((current) => current.filter((item) => item.id !== id))} onCheckout={() => status.open ? setView("checkout") : showNotice(`Estamos fechados. Próxima abertura: ${status.nextLabel}.`, "error")} onBack={() => setView("home")} />}

        {!search.trim() && view === "checkout" && <CheckoutView cartLines={cartLines} subtotal={subtotal} deliveryFee={deliveryFee} cardFee={cardFee} isCardPayment={isCardPayment} total={total} checkout={checkout} setCheckoutField={setCheckoutField} finishOrder={finishOrder} deliveryLocation={deliveryLocation} deliveryAssessment={deliveryAssessment} deliveryAllowed={deliveryAllowed} postalCodeStatus={postalCodeStatus} addressValidationStatus={addressValidationStatus} validateDeliveryAddress={validateDeliveryAddress} validatingAddress={validatingAddress} reviewDeliveryAddress={reviewDeliveryAddress} changeDeliveryLocation={changeDeliveryLocation} pixCopyStatus={pixCopyStatus} copyPixKey={copyPixKey} status={status} settings={store.settings} submitting={submittingOrder} session={session} addresses={account.addresses} onUseSavedAddress={useSavedAddress} onEditSavedAddress={editSavedAddress} onUseGps={useDeviceLocation} onUseManual={chooseManualAddress} gpsLoading={gpsLoading} accountPassword={accountPassword} setAccountPassword={setAccountPassword} recommendations={recommendations} onOpenRecommendation={setSelectedProduct} onBack={() => setView("cart")} />}

        {!search.trim() && view === "account" && <CustomerAccount session={session} account={account} loading={accountLoading} adminAuthorized={adminAuthorized} onBack={() => setView("home")} onLogin={loginCustomer} onSignOut={logoutAdmin} onSaveProfile={saveProfileFromAccount} onSaveAddress={saveAddressFromAccount} onDeleteAddress={removeAddressFromAccount} onUseAddress={(address) => { setView("checkout"); useSavedAddress(address); }} onRepeatOrder={repeatOrder} onNewOrder={() => setView("home")} onOpenAdmin={() => setView("admin")} />}

        {!search.trim() && view === "admin" && (authLoading
          ? <p className="empty">Verificando sessão...</p>
          : session && adminAuthorized
            ? <AdminPanel store={store} session={session} reloadStore={reloadStore} showNotice={showNotice} onSignOut={logoutAdmin} />
            : session
              ? <AdminAccessDenied message={adminAccessError} onSignOut={logoutAdmin} />
              : <AdminLogin showNotice={showNotice} />)}
      </main>

      <ProductDetails product={selectedProduct} onClose={() => setSelectedProduct(null)} onAdd={addToCart} />

      <nav className="bottom-nav">
        <button className={view === "home" ? "active" : ""} onClick={() => { setSearch(""); setView("home"); }}><Home size={21} /><span>Início</span></button>
        <button onClick={() => { setSearch(""); setView("home"); window.setTimeout(() => document.querySelector(".category-section")?.scrollIntoView({ behavior: "smooth" }), 0); }}><PackageCheck size={21} /><span>Categorias</span></button>
        <button className={view === "cart" ? "active" : ""} onClick={() => { setSearch(""); setView("cart"); }}><ShoppingCart size={21} /><span>Carrinho</span></button>
        <button className={view === "admin" ? "active" : ""} onClick={() => { setSearch(""); setView("admin"); }}><Lock size={21} /><span>Admin</span></button>
      </nav>
    </div>
  );
}

function ClosedNotice({ status }) {
  return <div className="closed-notice"><Lock size={19} /><div><strong>Estamos fechados para pedidos</strong><span>Você pode consultar o cardápio. Próxima abertura: {status.nextLabel}.</span></div></div>;
}

function ProductList({ title, subtitle, products, onAdd, onBack }) {
  return <section className="products-view"><button className="back-button" onClick={onBack}><ArrowLeft size={18} />Voltar</button><div className="section-title"><h1>{title}</h1>{subtitle && <span>{subtitle}</span>}</div><div className="product-grid">{products.map((product) => <article className={isSoldOut(product) ? "product-card soldout" : "product-card"} key={product.id}><img src={product.image} alt={product.name} /><div className="product-info"><div className="product-heading"><strong>{product.name}</strong><span className={isSoldOut(product) ? "status" : "status available"}>{product.status}</span></div><p>{product.description}</p><div className="product-action"><div className="price-block"><strong>{money(product.price)}</strong>{product.featured && <small>Destaque</small>}</div><button disabled={isSoldOut(product)} onClick={() => onAdd(product)}><Plus size={18} />Adicionar</button></div></div></article>)}</div>{products.length === 0 && <p className="empty">Nenhum produto encontrado.</p>}</section>;
}

function CartView({ cartLines, subtotal, deliveryFee, cardFee, isCardPayment, total, checkout, status, recommendations, onOpenRecommendation, onQty, onRemove, onCheckout, onBack }) {
  return <section className="cart-view"><button className="back-button" onClick={onBack}><ArrowLeft size={18} />Continuar escolhendo</button><div className="section-title"><h1>Carrinho</h1><span>Confira os itens antes de finalizar</span></div>{cartLines.length ? <><div className="cart-list">{cartLines.map((item) => <article className="cart-item" key={item.id}><img src={item.product.image} alt={item.product.name} /><div><strong>{item.product.name}</strong><span>{money(item.product.price)} cada</span><div className="qty-row"><button onClick={() => onQty(item.id, -1)} aria-label="Diminuir"><Minus size={16} /></button><b>{item.qty}</b><button onClick={() => onQty(item.id, 1)} aria-label="Aumentar"><Plus size={16} /></button><button className="ghost-danger" onClick={() => onRemove(item.id)} aria-label="Remover"><Trash2 size={16} /></button></div></div><strong>{money(item.lineTotal)}</strong></article>)}</div><Recommendations products={recommendations} onOpen={onOpenRecommendation} /><Totals subtotal={subtotal} deliveryFee={deliveryFee} cardFee={cardFee} isCardPayment={isCardPayment} total={total} deliveryType={checkout.deliveryType} /><button className="primary-action" disabled={!status.open} onClick={onCheckout}>{status.open ? "Finalizar pedido" : "Fechado para pedidos"}</button>{!status.open && <p className="action-help">Próxima abertura: {status.nextLabel}.</p>}</> : <p className="empty">Seu carrinho está vazio.</p>}</section>;
}

function CheckoutView({ cartLines, subtotal, deliveryFee, cardFee, isCardPayment, total, checkout, setCheckoutField, finishOrder, deliveryLocation, deliveryAssessment, deliveryAllowed, postalCodeStatus, addressValidationStatus, validateDeliveryAddress, validatingAddress, reviewDeliveryAddress, changeDeliveryLocation, pixCopyStatus, copyPixKey, status, settings, submitting, session, addresses, onUseSavedAddress, onEditSavedAddress, onUseGps, onUseManual, gpsLoading, accountPassword, setAccountPassword, recommendations, onOpenRecommendation, onBack }) {
  const needsAddress = checkout.deliveryType === "entrega";
  const blocked = !status.open || submitting || (needsAddress && !deliveryAllowed);
  const deliveryErrorMessage = ["error", "outside"].includes(addressValidationStatus.type)
    ? addressValidationStatus.message
    : deliveryAssessment.message;
  const showDeliveryError = needsAddress && !deliveryAssessment.allowed && !deliveryLocation && addressValidationStatus.type === "error";
  const defaultAddress = addresses.find((address) => address.is_default) || addresses[0];
  return <section className="checkout-view"><button className="back-button" onClick={onBack}><ArrowLeft size={18} />Voltar ao carrinho</button><div className="section-title"><h1>Checkout</h1><span>Validado e enviado pelo WhatsApp</span></div><form className="checkout-form" onSubmit={finishOrder}>
    <div className="option-group"><span>Tipo de entrega</span><div className="segmented"><button type="button" className={needsAddress ? "selected" : ""} onClick={() => setCheckoutField("deliveryType", "entrega")}><Bike size={17} />Entrega</button><button type="button" className={!needsAddress ? "selected" : ""} onClick={() => setCheckoutField("deliveryType", "retirada")}><Store size={17} />Retirada</button></div></div>
    <div className="checkout-section"><h2>Seus dados</h2><label>Nome<input required autoComplete="name" value={checkout.name} onChange={(event) => setCheckoutField("name", event.target.value)} /></label><label>Telefone<input required inputMode="tel" autoComplete="tel" value={checkout.phone} onChange={(event) => setCheckoutField("phone", event.target.value)} /></label></div>
    {needsAddress && <>
      {!checkout.locationFlow && defaultAddress && <div className="checkout-section saved-checkout-address"><h2>Entregar em</h2><strong>{defaultAddress.label || "Casa"}</strong><p>{defaultAddress.street}, {defaultAddress.number}</p><small>{[defaultAddress.complement, defaultAddress.neighborhood].filter(Boolean).join(" · ")}</small><div className="saved-checkout-actions"><button type="button" onClick={() => onUseSavedAddress(defaultAddress)}>Usar este endereço</button><button type="button" onClick={() => onEditSavedAddress(defaultAddress)}>Editar</button></div></div>}
      {!checkout.locationFlow && <LocationQuestion onGps={onUseGps} onManual={onUseManual} gpsLoading={gpsLoading} hasSavedAddress={Boolean(defaultAddress)} />}
      {checkout.locationFlow === "gps" && <div className="checkout-section gps-address-section"><h2>Endereço de entrega</h2>{gpsLoading && <div className="location-progress"><Navigation size={20} /><strong>Obtendo localização precisa...</strong></div>}{addressValidationStatus.type === "gps-error" && <div className="gps-fallback-panel"><strong>{addressValidationStatus.message}</strong><div><button type="button" onClick={onUseGps}>Tentar novamente</button><button type="button" onClick={() => onUseManual({ preserveFields: true })}>Usar endereço manual</button></div></div>}{deliveryLocation && <><label>Rua<input required autoComplete="address-line1" value={checkout.street} onChange={(event) => setCheckoutField("street", event.target.value)} /></label><div className="address-row"><label>Número<input id="delivery-number" required inputMode="numeric" value={checkout.number} onChange={(event) => setCheckoutField("number", event.target.value)} /></label><label>Complemento / referência<input autoComplete="address-line2" placeholder="Ex.: bloco, apartamento, casa, portão azul..." value={checkout.complement} onChange={(event) => setCheckoutField("complement", event.target.value)} /></label></div></>}</div>}
      {checkout.locationFlow === "address" && <div className="checkout-section"><h2>Endereço de entrega</h2><label>CEP<input id="delivery-postal-code" required inputMode="numeric" autoComplete="postal-code" value={checkout.postalCode} onChange={(event) => setCheckoutField("postalCode", formatPostalCode(event.target.value))} /></label>
        {postalCodeStatus.message && <small className={`address-helper ${postalCodeStatus.type}`}>{postalCodeStatus.message}</small>}
        <div className="address-row"><label>Rua<input required autoComplete="address-line1" value={checkout.street} onChange={(event) => setCheckoutField("street", event.target.value)} /></label><label>Número<input id="delivery-number" required inputMode="numeric" value={checkout.number} onChange={(event) => setCheckoutField("number", event.target.value)} /></label></div>
        <label>Complemento<input autoComplete="address-line2" placeholder="Ex.: bloco, apartamento, casa, portão azul..." value={checkout.complement} onChange={(event) => setCheckoutField("complement", event.target.value)} /></label>
        <label>Bairro<input required value={checkout.neighborhood} onChange={(event) => setCheckoutField("neighborhood", event.target.value)} /></label>
        <div className="address-row"><label>Cidade<input required autoComplete="address-level2" value={checkout.city} onChange={(event) => setCheckoutField("city", event.target.value)} /></label><label>Estado<input required autoComplete="address-level1" value={checkout.state} onChange={(event) => setCheckoutField("state", event.target.value)} /></label></div>
        <label>Ponto de referência<input value={checkout.reference} onChange={(event) => setCheckoutField("reference", event.target.value)} /></label>
      </div>}
      {checkout.locationFlow === "address" && <div className="location-tools"><button type="button" onClick={validateDeliveryAddress} disabled={validatingAddress || postalCodeStatus.type === "loading"}><MapPin size={17} />{validatingAddress ? "Localizando endereço..." : "Localizar endereço e calcular entrega"}</button></div>}
      {addressValidationStatus.type === "unavailable" && <div className="gps-fallback-panel"><strong>{addressValidationStatus.message}</strong><button type="button" className="gps-review-button" onClick={reviewDeliveryAddress}>Revisar endereço</button></div>}
      {deliveryLocation && <LocationStatusCard location={deliveryLocation} assessment={deliveryAssessment} deliveryMode={checkout.deliveryMode} onSelectUber={() => setCheckoutField("deliveryMode", "uber")} onChange={changeDeliveryLocation} />}
      {session && deliveryLocation && checkout.locationFlow !== "saved" && <label className="inline-check save-current-address"><input type="checkbox" checked={checkout.saveAddress} onChange={(event) => setCheckoutField("saveAddress", event.target.checked)} />Salvar este endereço na minha conta</label>}
    </>}
    <Recommendations products={recommendations} onOpen={onOpenRecommendation} />
    <div className="option-group"><span>Forma de pagamento</span><div className="payment-list"><PaymentButton icon={<Wallet size={18} />} active={checkout.payment === "pix"} label="Pix" onClick={() => setCheckoutField("payment", "pix")} /><PaymentButton icon={<Wallet size={18} />} active={checkout.payment === "dinheiro"} label="Dinheiro" onClick={() => setCheckoutField("payment", "dinheiro")} /><PaymentButton icon={<CreditCard size={18} />} active={checkout.payment === "credito"} label="Cartão de crédito" onClick={() => setCheckoutField("payment", "credito")} /><PaymentButton icon={<CreditCard size={18} />} active={checkout.payment === "debito"} label="Cartão de débito" onClick={() => setCheckoutField("payment", "debito")} /></div></div>
    {checkout.payment === "dinheiro" && <div className="option-group change-option"><span>Precisa de troco?</span><div className="segmented"><button type="button" className={!checkout.needsChange ? "selected" : ""} onClick={() => setCheckoutField("needsChange", false)}>Não</button><button type="button" className={checkout.needsChange ? "selected" : ""} onClick={() => setCheckoutField("needsChange", true)}>Sim</button></div>{checkout.needsChange && <label>Troco para quanto?<input inputMode="decimal" placeholder="R$ 100,00" value={checkout.changeFor} onBlur={() => setCheckoutField("changeFor", moneyFromInput(checkout.changeFor))} onChange={(event) => setCheckoutField("changeFor", event.target.value)} /></label>}</div>}
    {checkout.payment === "pix" && <PixPaymentCard settings={settings} copyStatus={pixCopyStatus} onCopy={copyPixKey} />}
    <label>Observação do pedido<textarea value={checkout.notes} onChange={(event) => setCheckoutField("notes", event.target.value)} /></label><div className="mini-order"><strong>{cartLines.length} item(ns) no pedido</strong><Totals subtotal={subtotal} deliveryFee={deliveryFee} cardFee={cardFee} isCardPayment={isCardPayment} total={total} deliveryType={checkout.deliveryType} deliveryMode={checkout.deliveryMode} deliveryDistance={deliveryLocation} /></div>
    {!session && <div className="checkout-section optional-account"><h2>Quer salvar seus dados para pedir mais rápido da próxima vez?</h2><p>Crie sua conta e deixe seus dados e endereço salvos para os próximos pedidos.</p><div className="segmented"><button type="button" className={checkout.accountChoice === "save" ? "selected" : ""} onClick={() => setCheckoutField("accountChoice", "save")}>Salvar meus dados</button><button type="button" className={checkout.accountChoice !== "save" ? "selected" : ""} onClick={() => { setCheckoutField("accountChoice", "guest"); setAccountPassword(""); }}>Continuar sem cadastro</button></div>{checkout.accountChoice === "save" && <div className="quick-account-fields"><label>E-mail<input required type="email" autoComplete="email" value={checkout.accountEmail} onChange={(event) => setCheckoutField("accountEmail", event.target.value)} /></label><label>Senha<input required minLength={6} type="password" autoComplete="new-password" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} /></label><small>Nome e telefone acima serão usados no seu perfil.</small></div>}</div>}
    {session && <div className="account-connected"><CheckCircle2 size={18} /><span>Pedido vinculado à sua conta ({session.user.email}).</span></div>}
    {!status.open && <div className="form-error">Estamos fechados. Próxima abertura: {status.nextLabel}.</div>}{showDeliveryError && <div className="form-error">{deliveryErrorMessage}</div>}
    <button className="primary-action" type="submit" disabled={blocked}><MessageCircle size={19} />{submitting ? "Validando e salvando..." : status.open ? "Enviar pedido para WhatsApp" : "Fechado para pedidos"}</button>
  </form></section>;
}

function LocationQuestion({ onGps, onManual, gpsLoading, hasSavedAddress }) {
  return <div className={`location-question ${hasSavedAddress ? "compact" : ""}`}><h2>{hasSavedAddress ? "Usar outro endereço" : "Você está no local da entrega?"}</h2><p>{hasSavedAddress ? "Você está no novo local da entrega?" : "Isso nos ajuda a calcular sua entrega com mais precisão."}</p><div className="location-choice-buttons"><button type="button" onClick={onGps} disabled={gpsLoading}><Navigation size={18} />{gpsLoading ? "Obtendo localização..." : "Sim, estou no local"}</button><button type="button" onClick={() => onManual()}><MapPin size={18} />Não, estou em outro lugar</button></div></div>;
}

function LocationStatusCard({ location, assessment, deliveryMode, onSelectUber, onChange }) {
  const uberSelected = deliveryMode === "uber" && assessment.uberAvailable;
  const title = assessment.allowed ? "Entrega disponível" : uberSelected ? "Uber Entrega selecionada" : "Fora da área de entrega própria";
  return <div className={`location-status-card ${assessment.allowed ? "success" : "warning"}`}>
    {assessment.allowed ? <CheckCircle2 size={24} /> : <TriangleAlert size={24} />}
    <div><strong>{title}</strong>{location.source === "gps" && <small>Localização validada ✓ · Precisão aproximada: {Math.round(Number(location.accuracy))} metros</small>}{assessment.allowed && <div className="location-fee"><span>Taxa de entrega</span><b>{money(assessment.fee)}</b></div>}{assessment.uberAvailable && <><p>Seu endereço está fora da nossa área de entrega própria. A rota tem aproximadamente {Number(location.km).toFixed(2)} km.</p>{!uberSelected && <><p>Nossa entrega própria atende até 3,5 km, mas você ainda pode fazer seu pedido e solicitar um Uber para retirada.</p><button type="button" className="uber-delivery-button" onClick={onSelectUber}>Quero retirar por Uber</button></>}<small>Após finalizar, você solicita o Uber para retirar na loja. O valor da corrida é pago diretamente ao aplicativo.</small></>}{!assessment.uberAvailable && location.km != null && Number.isFinite(Number(location.km)) && <small>Distância da rota: {Number(location.km).toFixed(2)} km</small>}<button type="button" className="location-change-button" onClick={onChange}>Alterar endereço</button></div>
  </div>;
}

function PixPaymentCard({ settings, copyStatus, onCopy }) {
  const qrCode = String(settings.pix_qr_code_url || "").trim();
  const [showQrCode, setShowQrCode] = useState(Boolean(qrCode));
  useEffect(() => setShowQrCode(Boolean(qrCode)), [qrCode]);
  return <section className="pix-box" aria-labelledby="pix-title">
    <h2 id="pix-title">Pix</h2>
    {showQrCode && <div className="pix-qr-frame"><img className="pix-qr" src={qrCode} alt="QR Code Pix" onError={() => setShowQrCode(false)} /></div>}
    <div className="pix-details"><span>Favorecido</span><strong>{settings.pix_name}</strong><span>Chave Pix</span><code>{settings.pix_key}</code></div>
    <button type="button" className="copy-pix-button" onClick={onCopy}>Copiar chave Pix</button>
    {copyStatus && <span className="pix-copy-status" role="status">{copyStatus}</span>}
    <small>Envie o pedido antes de realizar o pagamento. Depois, encaminhe o comprovante pelo WhatsApp.</small>
  </section>;
}

function PaymentButton({ icon, active, label, onClick }) {
  return <button type="button" className={active ? "payment selected" : "payment"} onClick={onClick}>{icon}{label}</button>;
}

function Totals({ subtotal, deliveryFee, cardFee = 0, isCardPayment = false, total, deliveryType, deliveryMode, deliveryDistance }) {
  const isUber = deliveryType === "entrega" && deliveryMode === "uber";
  return <div className="totals">{deliveryDistance && deliveryType === "entrega" && deliveryDistance.km != null && Number.isFinite(Number(deliveryDistance.km)) && <div className="distance-line"><span>Distância da rota</span><strong>{Number(deliveryDistance.km).toFixed(2)} km</strong></div>}<div><span>Subtotal</span><strong>{money(subtotal)}</strong></div>{isUber ? <><div><span>Entrega da loja</span><strong>{money(0)}</strong></div><small>Uber pago separadamente pelo cliente.</small></> : <div><span>{deliveryType === "retirada" ? "Retirada" : "Taxa de entrega"}</span><strong>{money(deliveryFee)}</strong></div>}{isCardPayment && <div><span>Taxa do cartão</span><strong>{money(cardFee)}</strong></div>}<div className="grand-total"><span>Total</span><strong>{money(total)}</strong></div></div>;
}

function AdminLogin({ showNotice }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(event) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    try { await signIn(email, password); showNotice("Acesso administrativo liberado.", "success"); }
    catch (error) { showNotice(error.message === "Invalid login credentials" ? "E-mail ou senha inválidos." : error.message, "error"); }
    finally { setLoading(false); }
  }
  return <section className="admin-view"><div className="section-title"><h1>Painel admin</h1><span>Acesso seguro com Supabase Auth</span></div><form className="admin-login" onSubmit={submit}><Lock size={28} /><label>E-mail<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Senha<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label><button className="primary-action" disabled={loading}>{loading ? "Entrando..." : "Entrar"}</button></form></section>;
}

function AdminAccessDenied({ message, onSignOut }) {
  return <section className="admin-view"><div className="admin-login"><TriangleAlert size={28} /><strong>Acesso administrativo não autorizado</strong><p className="empty">{message}</p><button className="primary-action" type="button" onClick={onSignOut}>Sair desta conta</button></div></section>;
}

export default App;
