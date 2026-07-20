import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BadgeCheck,
  Bike,
  CalendarDays,
  CheckCircle2,
  CreditCard,
  Edit3,
  Home,
  Lock,
  MapPin,
  MessageCircle,
  Minus,
  PackageCheck,
  Plus,
  Search,
  ShoppingCart,
  Store,
  TriangleAlert,
  Trash2,
  Wallet,
} from "lucide-react";
import {
  ADMIN_PASSWORD,
  BRAND,
  PIX_KEY,
  PIX_NAME,
  PIX_QR_CODE,
  WHATSAPP_NUMBER,
  categories,
  initialProducts,
} from "./menuData";
import { supabase } from "./lib/supabase";

const STORAGE_KEYS = {
  cart: "rafa-cart",
  orders: "rafa-orders",
};

const paymentLabels = {
  pix: "Pix",
  dinheiro: "Dinheiro",
  credito: "Cartão de crédito",
  debito: "Cartão de débito",
};

const STORE_LOCATION = {
  latitude: -22.943800658459434,
  longitude: -43.582438704219854,
};

function distanceInKm(origin, destination) {
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

function isLocalGeolocationHost() {
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function readStorage(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  } catch {
    return fallback;
  }
}

function money(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(value) || 0);
}

function moneyFromInput(value) {
  const trimmedValue = value.trim();
  if (!trimmedValue) return "";

  const normalizedValue = trimmedValue
    .replace(/\s/g, "")
    .replace(/^R\$/i, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const numericValue = Number(normalizedValue);

  return Number.isFinite(numericValue) ? money(numericValue) : trimmedValue;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function storeStatus() {
  const now = new Date();
  const day = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const openDay = day === 0 || day >= 4;
  const openTime = minutes >= 19 * 60 && minutes <= 23 * 60;

  if (openDay && openTime) {
    return { open: true, label: "Aberto agora", detail: "Hoje até 23h" };
  }

  return {
    open: false,
    label: "Fechado agora",
    detail: "Quinta a domingo, 19h às 23h",
  };
}

const initialProductOrder = new Map(initialProducts.map((product, index) => [product.id, index]));

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function normalizeProductStatus(status) {
  const normalizedStatus = normalizeText(status);

  if (normalizedStatus === "esgotado" || normalizedStatus === "indisponivel") {
    return "Esgotado";
  }

  return "Disponível";
}

function isProductAvailable(product) {
  return normalizeProductStatus(product.status) === "Disponível";
}

function isProductSoldOut(product) {
  return normalizeProductStatus(product.status) === "Esgotado";
}

function comboNumber(product) {
  if (product.category !== "combos") return null;

  const text = normalizeText(`${product.id} ${product.name}`);
  const match = text.match(/\bcombo\D*([0-9]+)\b/);
  return match ? Number(match[1]) : null;
}

function toDatabaseProduct(product) {
  return {
    id: product.id,
    category: product.category,
    name: product.name,
    price: Number(product.price) || 0,
    image_url: product.image,
    description: product.description,
    status: normalizeProductStatus(product.status),
    visible: product.visible !== false,
  };
}

function fromDatabaseProduct(product) {
  return {
    id: product.id,
    category: product.category,
    name: product.name,
    price: Number(product.price) || 0,
    image: product.image || product.image_url,
    description: product.description || "",
    status: normalizeProductStatus(product.status),
    visible: product.visible !== false,
    needsAdminPrice: Boolean(
      product.needs_admin_price ?? product.needsAdminPrice ?? (product.category === "bebidas" && Number(product.price) === 0),
    ),
  };
}

function orderProducts(products) {
  return [...products].sort((firstProduct, secondProduct) => {
    const firstCategory = categories.findIndex((category) => category.id === firstProduct.category);
    const secondCategory = categories.findIndex((category) => category.id === secondProduct.category);
    if (firstCategory !== secondCategory) return firstCategory - secondCategory;

    const firstComboNumber = comboNumber(firstProduct);
    const secondComboNumber = comboNumber(secondProduct);
    if (firstComboNumber !== null && secondComboNumber !== null) return firstComboNumber - secondComboNumber;
    if (firstComboNumber !== null) return -1;
    if (secondComboNumber !== null) return 1;

    const firstOrder = initialProductOrder.get(firstProduct.id);
    const secondOrder = initialProductOrder.get(secondProduct.id);

    if (firstOrder !== undefined && secondOrder !== undefined) return firstOrder - secondOrder;
    if (firstOrder !== undefined) return -1;
    if (secondOrder !== undefined) return 1;

    return firstProduct.name.localeCompare(secondProduct.name, "pt-BR");
  });
}

async function loadProductsFromSupabase() {
  const { data, error } = await supabase.from("products").select("*");

  if (error) {
    throw error;
  }

  if (data?.length) {
    return orderProducts(data.map(fromDatabaseProduct));
  }

  const productsToImport = initialProducts.map(toDatabaseProduct);
  const { data: importedProducts, error: importError } = await supabase
    .from("products")
    .insert(productsToImport)
    .select("*");

  if (importError) {
    const { data: retriedProducts } = await supabase.from("products").select("*");
    if (retriedProducts?.length) {
      return orderProducts(retriedProducts.map(fromDatabaseProduct));
    }

    throw importError;
  }

  return orderProducts((importedProducts?.length ? importedProducts : productsToImport).map(fromDatabaseProduct));
}

function databaseFieldFor(field) {
  if (field === "image") return "image_url";
  return field;
}

function normalizeProductField(field, value) {
  if (field === "price") return Number(value);
  if (field === "visible") return Boolean(value);
  if (field === "status") return normalizeProductStatus(value);
  return value;
}

async function saveProductField(productId, field, value) {
  const { error } = await supabase
    .from("products")
    .update({ [databaseFieldFor(field)]: normalizeProductField(field, value) })
    .eq("id", productId);

  if (error) {
    throw error;
  }
}

const productSaveQueues = new Map();

function queueProductFieldSave(productId, field, value) {
  const key = `${productId}:${field}`;
  const previousSave = productSaveQueues.get(key) || Promise.resolve();
  const nextSave = previousSave
    .catch(() => {})
    .then(() => saveProductField(productId, field, value));
  const queuedSave = nextSave.finally(() => {
    if (productSaveQueues.get(key) === queuedSave) {
      productSaveQueues.delete(key);
    }
  });

  productSaveQueues.set(key, queuedSave);

  return queuedSave;
}

function isVisibleToCustomers(product) {
  return product.category !== "bebidas" || product.visible !== false;
}

function App() {
  const [products, setProducts] = useState([]);
  const [isLoadingProducts, setIsLoadingProducts] = useState(true);
  const [cart, setCart] = useState(() => readStorage(STORAGE_KEYS.cart, []));
  const [orders, setOrders] = useState(() => readStorage(STORAGE_KEYS.orders, []));
  const [view, setView] = useState("home");
  const [activeCategory, setActiveCategory] = useState(null);
  const [search, setSearch] = useState("");
  const [checkout, setCheckout] = useState({
    name: "",
    phone: "",
    address: "",
    reference: "",
    deliveryType: "entrega",
    payment: "pix",
    needsChange: false,
    changeFor: "",
    notes: "",
  });
  const [deliveryDistance, setDeliveryDistance] = useState(null);
  const [locationStatus, setLocationStatus] = useState("");
  const [useExternalDelivery, setUseExternalDelivery] = useState(false);
  const [pixCopyStatus, setPixCopyStatus] = useState("");
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    loadProducts();
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.cart, JSON.stringify(cart));
  }, [cart]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.orders, JSON.stringify(orders));
  }, [orders]);

  useEffect(() => {
    if (useExternalDelivery && checkout.payment !== "pix") {
      setCheckout((current) => ({ ...current, payment: "pix", needsChange: false, changeFor: "" }));
    }
  }, [checkout.payment, useExternalDelivery]);

  const status = storeStatus();
  const cartLines = useMemo(
    () =>
      cart
        .map((item) => {
          const product = products.find((candidate) => candidate.id === item.id);
          return product ? { ...item, product, lineTotal: product.price * item.qty } : null;
        })
        .filter(Boolean),
    [cart, products],
  );
  const cartCount = cart.reduce((total, item) => total + item.qty, 0);
  const subtotal = cartLines.reduce((total, item) => total + item.lineTotal, 0);
  const isOutsideDeliveryRadius = checkout.deliveryType === "entrega" && deliveryDistance?.km > 2;
  const isExternalDelivery = isOutsideDeliveryRadius && useExternalDelivery;
  const deliveryFee =
    checkout.deliveryType === "entrega" && !isOutsideDeliveryRadius && subtotal < 25 ? 5 : 0;
  const isCardPayment = checkout.payment === "credito" || checkout.payment === "debito";
  const cardFee = isCardPayment ? (subtotal + deliveryFee) * 0.05 : 0;
  const total = subtotal + deliveryFee + cardFee;
  const currentCategory = categories.find((category) => category.id === activeCategory);
  const filteredProducts = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return [];
    return products.filter((product) => {
      if (!isVisibleToCustomers(product)) return false;
      return (
        product.name.toLowerCase().includes(term) ||
        product.description.toLowerCase().includes(term) ||
        categories.find((category) => category.id === product.category)?.name.toLowerCase().includes(term)
      );
    });
  }, [products, search]);
  const dailyOrders = orders.filter((order) => order.date === todayKey());

  function showNotice(message) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2400);
  }

  async function loadProducts() {
    setIsLoadingProducts(true);

    try {
      const loadedProducts = await loadProductsFromSupabase();
      setProducts(loadedProducts);
    } catch (error) {
      console.error("Erro ao carregar produtos do Supabase:", error);
      showNotice("Não foi possível carregar os produtos do Supabase.");
      setProducts([]);
    } finally {
      setIsLoadingProducts(false);
    }
  }

  function openCategory(categoryId) {
    setActiveCategory(categoryId);
    setSearch("");
    setView("category");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function addToCart(product) {
    if (isProductSoldOut(product)) {
      showNotice("Produto esgotado não pode ser adicionado.");
      return;
    }

    setCart((current) => {
      const existing = current.find((item) => item.id === product.id);
      if (existing) {
        return current.map((item) => (item.id === product.id ? { ...item, qty: item.qty + 1 } : item));
      }
      return [...current, { id: product.id, qty: 1 }];
    });
    showNotice("Produto adicionado ao carrinho.");
  }

  function updateQty(productId, delta) {
    setCart((current) =>
      current
        .map((item) => (item.id === productId ? { ...item, qty: Math.max(0, item.qty + delta) } : item))
        .filter((item) => item.qty > 0),
    );
  }

  function removeItem(productId) {
    setCart((current) => current.filter((item) => item.id !== productId));
  }

  function setCheckoutField(field, value) {
    if (field === "deliveryType") {
      setUseExternalDelivery(false);
    }
    setCheckout((current) => {
      const nextCheckout = {
        ...current,
        [field]: value,
      };

      if (field === "payment" && value !== "dinheiro") {
        nextCheckout.needsChange = false;
        nextCheckout.changeFor = "";
      }

      if (field === "needsChange" && !value) {
        nextCheckout.changeFor = "";
      }

      return nextCheckout;
    });
  }

  function useCustomerLocation() {
    setDeliveryDistance(null);
    setUseExternalDelivery(false);

    if (!("geolocation" in navigator)) {
      setLocationStatus("Seu navegador não permite localização automática.");
      return;
    }

    setLocationStatus("Buscando localização...");

    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const customerLocation = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          };
          const km = distanceInKm(STORE_LOCATION, customerLocation);
          setDeliveryDistance({
            km,
            latitude: customerLocation.latitude,
            longitude: customerLocation.longitude,
          });
          if (km <= 2) {
            setUseExternalDelivery(false);
          }
          setLocationStatus("");
        },
        () => {
          const networkHint = isLocalGeolocationHost()
            ? ""
            : " No celular pelo IP da rede, use o endereço manualmente se o navegador bloquear a localização.";
          setLocationStatus(
            `Não foi possível acessar sua localização. Verifique a permissão do navegador ou informe o endereço manualmente.${networkHint}`,
          );
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
      );
    } catch {
      setLocationStatus(
        "Não foi possível acessar sua localização. Verifique a permissão do navegador ou informe o endereço manualmente.",
      );
    }
  }

  function updateProduct(productId, field, value) {
    const normalizedValue = normalizeProductField(field, value);

    setProducts((current) =>
      current.map((product) => {
        if (product.id !== productId) return product;
        if (field === "price") {
          return { ...product, price: normalizedValue, needsAdminPrice: false };
        }
        return { ...product, [field]: normalizedValue };
      }),
    );

    const updates = [[field, normalizedValue]];

    Promise.all(updates.map(([fieldName, fieldValue]) => queueProductFieldSave(productId, fieldName, fieldValue))).catch(
      (error) => {
        console.error("Erro ao salvar produto no Supabase:", error);
        showNotice("Não foi possível salvar a alteração no Supabase.");
        loadProducts();
      },
    );
  }

  async function copyPixKey() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(PIX_KEY);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = PIX_KEY;
        textArea.setAttribute("readonly", "");
        textArea.style.position = "fixed";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }
      setPixCopyStatus("Chave Pix copiada.");
    } catch {
      setPixCopyStatus("Não foi possível copiar. Toque e segure para copiar a chave.");
    }
    window.setTimeout(() => setPixCopyStatus(""), 2400);
  }

  function buildWhatsappMessage() {
    const itemLines = cartLines
      .map((item) => `• ${item.qty}x ${item.product.name}`)
      .join("\n");
    const isPickup = checkout.deliveryType === "retirada";
    const addressText = isPickup ? "Retirada no local" : checkout.address;
    const paymentLines =
      checkout.payment === "dinheiro"
        ? [
            "Pagamento: Dinheiro",
            checkout.needsChange ? `Troco para: ${moneyFromInput(checkout.changeFor)}` : "",
          ]
        : [`💳 ${paymentLabels[checkout.payment]}`];

    return [
      "🍔 NOVO PEDIDO",
      "",
      `👤 ${checkout.name}`,
      `📞 ${checkout.phone}`,
      "",
      `📍 ${addressText}`,
      "",
      "🛒 Itens",
      itemLines,
      "",
      `💰 Total: ${money(total)}`,
      ...paymentLines,
      "",
      checkout.notes ? `📝 ${checkout.notes}` : "📝 Sem observação",
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  function finishOrder(event) {
    event.preventDefault();
    if (!cartLines.length) {
      showNotice("Adicione pelo menos um produto ao carrinho.");
      return;
    }

    if (isOutsideDeliveryRadius && !useExternalDelivery) {
      showNotice("Endereço fora da área de entrega. Use Uber Flash/99 Moto para combinar o envio.");
      return;
    }

    if (checkout.payment === "dinheiro" && checkout.needsChange && !checkout.changeFor.trim()) {
      showNotice("Informe para quanto precisa de troco.");
      return;
    }

    const order = {
      id: crypto.randomUUID(),
      date: todayKey(),
      createdAt: new Date().toISOString(),
      customer: checkout,
      distanceKm: deliveryDistance?.km || null,
      externalDelivery: isExternalDelivery,
      items: cartLines.map((item) => ({
        id: item.id,
        name: item.product.name,
        qty: item.qty,
        price: item.product.price,
        total: item.lineTotal,
      })),
      subtotal,
      deliveryFee,
      cardFee,
      total,
    };

    setOrders((current) => [order, ...current]);
    localStorage.setItem(STORAGE_KEYS.orders, JSON.stringify([order, ...orders]));

    const url = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(buildWhatsappMessage())}`;
    window.open(url, "_self");
    setCart([]);
    setView("home");
    showNotice("Pedido salvo e enviado para o WhatsApp.");
  }

  function tryUnlockAdmin(event) {
    event.preventDefault();
    if (adminPassword === ADMIN_PASSWORD) {
      setAdminUnlocked(true);
      setAdminPassword("");
      return;
    }
    showNotice("Senha do admin incorreta.");
  }

  async function resetProducts() {
    const restoredProducts = orderProducts(initialProducts);
    setProducts(restoredProducts);

    try {
      const { error } = await supabase.from("products").upsert(initialProducts.map(toDatabaseProduct), {
        onConflict: "id",
      });

      if (error) {
        throw error;
      }

      showNotice("Cardápio restaurado no Supabase.");
    } catch (error) {
      console.error("Erro ao restaurar produtos no Supabase:", error);
      showNotice("Não foi possível restaurar no Supabase.");
      loadProducts();
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand-button" onClick={() => setView("home")} aria-label="Início">
          <img src={BRAND.logo} alt="Rafa, to com fome" />
        </button>
        <div className="store-chip">
          <span className={status.open ? "pulse open" : "pulse"} />
          <div>
            <strong>{status.label}</strong>
            <small>{status.detail}</small>
          </div>
        </div>
        <button className="cart-button" onClick={() => setView("cart")} aria-label="Abrir carrinho">
          <ShoppingCart size={22} />
          {cartCount > 0 && <span>{cartCount}</span>}
        </button>
      </header>

      <main>
        <section className="search-wrap">
          <Search size={18} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar produtos"
            aria-label="Buscar produtos"
          />
        </section>

        {notice && <div className="notice">{notice}</div>}
        {isLoadingProducts && <div className="notice">Carregando produtos...</div>}

        {search.trim() ? (
          <ProductList
            title="Resultado da busca"
            products={filteredProducts}
            onAdd={addToCart}
            onBack={() => setSearch("")}
          />
        ) : null}

        {!search.trim() && view === "home" && (
          <>
            <section className="hero">
              <img src={BRAND.hero} alt="Banner principal Rafa, to com fome" />
            </section>

            <section className="category-section">
              <div className="section-title">
                <h1>Categorias</h1>
                <span>Escolha sua fome</span>
              </div>
              <div className="category-stack">
                {categories.map((category) => (
                  <button
                    className="category-banner"
                    key={category.id}
                    type="button"
                    aria-label={`Abrir ${category.name}`}
                    onClick={() => openCategory(category.id)}
                  >
                    <img src={category.banner} alt={category.name} />
                  </button>
                ))}
              </div>
            </section>
          </>
        )}

        {!search.trim() && view === "category" && (
          <ProductList
            title={currentCategory?.name || "Produtos"}
            subtitle={currentCategory?.description}
            products={products.filter((product) => product.category === activeCategory && isVisibleToCustomers(product))}
            onAdd={addToCart}
            onBack={() => setView("home")}
          />
        )}

        {!search.trim() && view === "cart" && (
          <CartView
            cartLines={cartLines}
            subtotal={subtotal}
            deliveryFee={deliveryFee}
            cardFee={cardFee}
            isCardPayment={isCardPayment}
            total={total}
            checkout={checkout}
            onQty={updateQty}
            onRemove={removeItem}
            onCheckout={() => setView("checkout")}
            onBack={() => setView("home")}
          />
        )}

        {!search.trim() && view === "checkout" && (
          <CheckoutView
            cartLines={cartLines}
            subtotal={subtotal}
            deliveryFee={deliveryFee}
            cardFee={cardFee}
            isCardPayment={isCardPayment}
            total={total}
            checkout={checkout}
            setCheckoutField={setCheckoutField}
            finishOrder={finishOrder}
            deliveryDistance={deliveryDistance}
            locationStatus={locationStatus}
            useCustomerLocation={useCustomerLocation}
            isOutsideDeliveryRadius={isOutsideDeliveryRadius}
            useExternalDelivery={useExternalDelivery}
            setUseExternalDelivery={setUseExternalDelivery}
            isExternalDelivery={isExternalDelivery}
            pixCopyStatus={pixCopyStatus}
            copyPixKey={copyPixKey}
            onBack={() => setView("cart")}
          />
        )}

        {!search.trim() && view === "admin" && (
          <AdminView
            products={products}
            orders={dailyOrders}
            unlocked={adminUnlocked}
            password={adminPassword}
            setPassword={setAdminPassword}
            tryUnlock={tryUnlockAdmin}
            updateProduct={updateProduct}
            resetProducts={resetProducts}
            onBack={() => setView("home")}
          />
        )}
      </main>

      <nav className="bottom-nav">
        <button className={view === "home" ? "active" : ""} onClick={() => setView("home")}>
          <Home size={21} />
          <span>Início</span>
        </button>
        <button onClick={() => document.querySelector(".category-section")?.scrollIntoView({ behavior: "smooth" })}>
          <PackageCheck size={21} />
          <span>Categorias</span>
        </button>
        <button className={view === "cart" ? "active" : ""} onClick={() => setView("cart")}>
          <ShoppingCart size={21} />
          <span>Carrinho</span>
        </button>
        <button className={view === "admin" ? "active" : ""} onClick={() => setView("admin")}>
          <Lock size={21} />
          <span>Admin</span>
        </button>
      </nav>
    </div>
  );
}

function ProductList({ title, subtitle, products, onAdd, onBack }) {
  return (
    <section className="products-view">
      <button className="back-button" onClick={onBack}>
        <ArrowLeft size={18} />
        Voltar
      </button>
      <div className="section-title">
        <h1>{title}</h1>
        {subtitle && <span>{subtitle}</span>}
      </div>
      <div className="product-grid">
        {products.map((product) => (
          <article className={isProductSoldOut(product) ? "product-card soldout" : "product-card"} key={product.id}>
            <img src={product.image} alt={product.name} />
            <div className="product-info">
              <div className="product-heading">
                <strong>{product.name}</strong>
                <span className={isProductAvailable(product) ? "status available" : "status"}>
                  {normalizeProductStatus(product.status)}
                </span>
              </div>
              <p>{product.description}</p>
              <div className="product-action">
                <div className="price-block">
                  <strong>{money(product.price)}</strong>
                  {product.needsAdminPrice && product.price === 0 && <small>Definir no admin</small>}
                </div>
                <button disabled={isProductSoldOut(product)} onClick={() => onAdd(product)}>
                  <Plus size={18} />
                  Adicionar
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {products.length === 0 && <p className="empty">Nenhum produto encontrado.</p>}
    </section>
  );
}

function CartView({
  cartLines,
  subtotal,
  deliveryFee,
  cardFee,
  isCardPayment,
  total,
  checkout,
  onQty,
  onRemove,
  onCheckout,
  onBack,
}) {
  return (
    <section className="cart-view">
      <button className="back-button" onClick={onBack}>
        <ArrowLeft size={18} />
        Continuar escolhendo
      </button>
      <div className="section-title">
        <h1>Carrinho</h1>
        <span>Confira os itens antes de finalizar</span>
      </div>

      {cartLines.length ? (
        <>
          <div className="cart-list">
            {cartLines.map((item) => (
              <article className="cart-item" key={item.id}>
                <img src={item.product.image} alt={item.product.name} />
                <div>
                  <strong>{item.product.name}</strong>
                  <span>{money(item.product.price)} cada</span>
                  <div className="qty-row">
                    <button onClick={() => onQty(item.id, -1)} aria-label="Diminuir quantidade">
                      <Minus size={16} />
                    </button>
                    <b>{item.qty}</b>
                    <button onClick={() => onQty(item.id, 1)} aria-label="Aumentar quantidade">
                      <Plus size={16} />
                    </button>
                    <button className="ghost-danger" onClick={() => onRemove(item.id)} aria-label="Remover item">
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                <strong>{money(item.lineTotal)}</strong>
              </article>
            ))}
          </div>
          <Totals
            subtotal={subtotal}
            deliveryFee={deliveryFee}
            cardFee={cardFee}
            isCardPayment={isCardPayment}
            total={total}
            deliveryType={checkout.deliveryType}
          />
          <button className="primary-action" onClick={onCheckout}>
            Finalizar pedido
          </button>
        </>
      ) : (
        <p className="empty">Seu carrinho está vazio.</p>
      )}
    </section>
  );
}

function CheckoutView({
  cartLines,
  subtotal,
  deliveryFee,
  cardFee,
  isCardPayment,
  total,
  checkout,
  setCheckoutField,
  finishOrder,
  deliveryDistance,
  locationStatus,
  useCustomerLocation,
  isOutsideDeliveryRadius,
  useExternalDelivery,
  setUseExternalDelivery,
  isExternalDelivery,
  pixCopyStatus,
  copyPixKey,
  onBack,
}) {
  const onlyPix = isExternalDelivery;
  const needsAddress = checkout.deliveryType !== "retirada";
  const isLocating = locationStatus === "Buscando localização...";
  return (
    <section className="checkout-view">
      <button className="back-button" onClick={onBack}>
        <ArrowLeft size={18} />
        Voltar ao carrinho
      </button>
      <div className="section-title">
        <h1>Checkout</h1>
        <span>O pedido será enviado pelo WhatsApp</span>
      </div>

      <form className="checkout-form" onSubmit={finishOrder}>
        <label>
          Nome
          <input required value={checkout.name} onChange={(event) => setCheckoutField("name", event.target.value)} />
        </label>
        <label>
          Telefone
          <input required value={checkout.phone} onChange={(event) => setCheckoutField("phone", event.target.value)} />
        </label>
        <label>
          Endereço
          <input
            required={needsAddress}
            value={checkout.address}
            onChange={(event) => setCheckoutField("address", event.target.value)}
          />
        </label>
        <label>
          Referência
          <input
            value={checkout.reference}
            onChange={(event) => setCheckoutField("reference", event.target.value)}
          />
        </label>

        <div className="option-group">
          <span>Tipo de entrega</span>
          <div className="segmented">
            <button
              type="button"
              className={checkout.deliveryType === "entrega" ? "selected" : ""}
              onClick={() => setCheckoutField("deliveryType", "entrega")}
            >
              <Bike size={17} />
              Entrega
            </button>
            <button
              type="button"
              className={checkout.deliveryType === "retirada" ? "selected" : ""}
              onClick={() => setCheckoutField("deliveryType", "retirada")}
            >
              <Store size={17} />
              Retirada
            </button>
          </div>
        </div>

        {checkout.deliveryType !== "retirada" && (
          <div className="location-tools">
            <button type="button" onClick={useCustomerLocation} disabled={isLocating}>
              <MapPin size={17} />
              {isLocating ? "Buscando localização..." : "Usar minha localização"}
            </button>
            {locationStatus && <small>{locationStatus}</small>}
          </div>
        )}

        {deliveryDistance && checkout.deliveryType !== "retirada" && (
          <LocationStatusCard distanceKm={deliveryDistance.km} isOutside={isOutsideDeliveryRadius} />
        )}

        {isOutsideDeliveryRadius && (
          <div className="delivery-note">
            <p>Seu endereço está fora da área de entrega. Você pode solicitar Uber Flash ou 99 Moto para combinar o envio pelo WhatsApp.</p>
            <button type="button" onClick={() => setUseExternalDelivery(true)}>
              Usar Uber Flash/99 Moto
            </button>
            {useExternalDelivery && <small>Entrega via Uber Flash/99 Moto a combinar pelo WhatsApp.</small>}
          </div>
        )}

        <div className="option-group">
          <span>Forma de pagamento</span>
          <div className="payment-list">
            <PaymentButton
              icon={<Wallet size={18} />}
              active={checkout.payment === "pix"}
              label="Pix"
              onClick={() => setCheckoutField("payment", "pix")}
            />
            {!onlyPix && (
              <>
                <PaymentButton
                  icon={<Wallet size={18} />}
                  active={checkout.payment === "dinheiro"}
                  label="Dinheiro"
                  onClick={() => setCheckoutField("payment", "dinheiro")}
                />
                <PaymentButton
                  icon={<CreditCard size={18} />}
                  active={checkout.payment === "credito"}
                  label="Cartão de crédito"
                  onClick={() => setCheckoutField("payment", "credito")}
                />
                <PaymentButton
                  icon={<CreditCard size={18} />}
                  active={checkout.payment === "debito"}
                  label="Cartão de débito"
                  onClick={() => setCheckoutField("payment", "debito")}
                />
              </>
            )}
          </div>
        </div>

        {checkout.payment === "dinheiro" && (
          <div className="option-group change-option">
            <span>Precisa de troco?</span>
            <div className="segmented">
              <button
                type="button"
                className={!checkout.needsChange ? "selected" : ""}
                onClick={() => setCheckoutField("needsChange", false)}
              >
                Não
              </button>
              <button
                type="button"
                className={checkout.needsChange ? "selected" : ""}
                onClick={() => setCheckoutField("needsChange", true)}
              >
                Sim
              </button>
            </div>
            {checkout.needsChange && (
              <label>
                Troco para quanto?
                <input
                  inputMode="decimal"
                  placeholder="R$ 100,00"
                  value={checkout.changeFor}
                  onBlur={() => setCheckoutField("changeFor", moneyFromInput(checkout.changeFor))}
                  onChange={(event) => setCheckoutField("changeFor", event.target.value)}
                />
              </label>
            )}
          </div>
        )}

        {checkout.payment === "pix" && (
          <div className="pix-box">
            <img className="pix-qr" src={PIX_QR_CODE} alt="QR Code Pix" />
            <div>
              <strong>Pix CNPJ</strong>
              <p>Nome: {PIX_NAME}</p>
              <button type="button" className="copy-pix-button" onClick={copyPixKey}>
                Copiar chave Pix
              </button>
              {pixCopyStatus && <span className="pix-copy-status">{pixCopyStatus}</span>}
              <small>Envie o pedido no WhatsApp antes de pagar. Depois copie a chave Pix, faça o pagamento e envie o comprovante por lá.</small>
            </div>
          </div>
        )}

        <label>
          Observação do pedido
          <textarea value={checkout.notes} onChange={(event) => setCheckoutField("notes", event.target.value)} />
        </label>

        <div className="mini-order">
          <strong>{cartLines.length} item(ns) no pedido</strong>
          <Totals
            subtotal={subtotal}
            deliveryFee={deliveryFee}
            cardFee={cardFee}
            isCardPayment={isCardPayment}
            total={total}
            deliveryType={checkout.deliveryType}
            deliveryDistance={deliveryDistance}
            isExternalDelivery={isExternalDelivery}
          />
        </div>
        <button className="primary-action" type="submit">
          <MessageCircle size={19} />
          Enviar para WhatsApp
        </button>
      </form>
    </section>
  );
}

function LocationStatusCard({ distanceKm, isOutside }) {
  if (isOutside) {
    return (
      <div className="location-status-card warning">
        <TriangleAlert size={24} />
        <div>
          <strong>Você está fora da área de entrega</strong>
          <p>Distância aproximada: {distanceKm.toFixed(1)} km.</p>
          <p>Mas não se preocupe.</p>
          <p>Você pode solicitar Uber Flash ou 99 Moto e combinar o envio pelo WhatsApp.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="location-status-card success">
      <CheckCircle2 size={24} />
      <div>
        <strong>Você está dentro da nossa área de entrega</strong>
        <p>Entrega disponível para seu endereço.</p>
        <p>Distância aproximada: {distanceKm.toFixed(1)} km.</p>
        <p>Seu pedido pode ser entregue normalmente.</p>
      </div>
    </div>
  );
}

function PaymentButton({ icon, active, label, onClick }) {
  return (
    <button type="button" className={active ? "payment selected" : "payment"} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}

function Totals({
  subtotal,
  deliveryFee,
  cardFee = 0,
  isCardPayment = false,
  total,
  deliveryType,
  deliveryDistance,
  isExternalDelivery = false,
}) {
  return (
    <div className="totals">
      {deliveryDistance && deliveryType !== "retirada" && (
        <div className="distance-line">
          <span>Distância aproximada</span>
          <strong>{deliveryDistance.km.toFixed(1)} km</strong>
        </div>
      )}
      <div>
        <span>Subtotal</span>
        <strong>{money(subtotal)}</strong>
      </div>
      <div>
        <span>{isExternalDelivery ? "Uber Flash/99 Moto" : deliveryType === "retirada" ? "Retirada" : "Entrega"}</span>
        <strong>{money(deliveryFee)}</strong>
      </div>
      {isCardPayment && (
        <div>
          <span>Taxa cartão 5%</span>
          <strong>{money(cardFee)}</strong>
        </div>
      )}
      <div className="grand-total">
        <span>Total</span>
        <strong>{money(total)}</strong>
      </div>
    </div>
  );
}

function AdminView({
  products,
  orders,
  unlocked,
  password,
  setPassword,
  tryUnlock,
  updateProduct,
  resetProducts,
  onBack,
}) {
  return (
    <section className="admin-view">
      <button className="back-button" onClick={onBack}>
        <ArrowLeft size={18} />
        Voltar ao app
      </button>
      <div className="section-title">
        <h1>Painel admin</h1>
        <span>Senha obrigatória para alterar o cardápio</span>
      </div>

      {!unlocked ? (
        <form className="admin-login" onSubmit={tryUnlock}>
          <Lock size={28} />
          <label>
            Senha
            <input
              type="password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Digite a senha"
            />
          </label>
          <button className="primary-action" type="submit">
            Entrar
          </button>
        </form>
      ) : (
        <>
          <div className="admin-metrics">
            <article>
              <CalendarDays size={22} />
              <span>Pedidos de hoje</span>
              <strong>{orders.length}</strong>
            </article>
            <article>
              <BadgeCheck size={22} />
              <span>Produtos</span>
              <strong>{products.length}</strong>
            </article>
          </div>

          <section className="orders-panel">
            <h2>Pedidos do dia</h2>
            {orders.length ? (
              orders.map((order) => (
                <article key={order.id}>
                  <strong>{order.customer.name}</strong>
                  <span>
                    {new Date(order.createdAt).toLocaleTimeString("pt-BR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    - {money(order.total)}
                  </span>
                  <small>{order.items.map((item) => `${item.qty}x ${item.name}`).join(", ")}</small>
                </article>
              ))
            ) : (
              <p className="empty">Nenhum pedido salvo hoje neste navegador.</p>
            )}
          </section>

          <div className="admin-heading">
            <h2>Editar produtos</h2>
            <button onClick={resetProducts}>
              <Edit3 size={16} />
              Restaurar cardápio
            </button>
          </div>
          <div className="admin-products">
            {products.map((product) => (
              <article className="admin-product" key={product.id}>
                <img src={product.image} alt={product.name} />
                <div className="admin-fields">
                  <label>
                    Nome
                    <input value={product.name} onChange={(event) => updateProduct(product.id, "name", event.target.value)} />
                  </label>
                  <label>
                    Descrição
                    <textarea
                      value={product.description}
                      onChange={(event) => updateProduct(product.id, "description", event.target.value)}
                    />
                  </label>
                  <div className="field-row">
                    <label>
                      Preço
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={product.price}
                        onChange={(event) => updateProduct(product.id, "price", event.target.value)}
                      />
                    </label>
                    <label>
                      Categoria
                      <select
                        value={product.category}
                        onChange={(event) => updateProduct(product.id, "category", event.target.value)}
                      >
                        {categories.map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label>
                    URL da imagem
                    <input value={product.image} onChange={(event) => updateProduct(product.id, "image", event.target.value)} />
                  </label>
                  <label>
                    Status
                    <select value={product.status} onChange={(event) => updateProduct(product.id, "status", event.target.value)}>
                      <option>Disponível</option>
                      <option>Esgotado</option>
                    </select>
                  </label>
                  {product.category === "bebidas" && (
                    <label className="admin-check">
                      <input
                        type="checkbox"
                        checked={product.visible !== false}
                        onChange={(event) => updateProduct(product.id, "visible", event.target.checked)}
                      />
                      Visível para clientes
                    </label>
                  )}
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export default App;





