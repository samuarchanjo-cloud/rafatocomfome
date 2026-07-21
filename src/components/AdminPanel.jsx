import React, { useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  CalendarDays,
  Clock3,
  ImagePlus,
  LayoutDashboard,
  ListFilter,
  LogOut,
  PackageCheck,
  Plus,
  Save,
  Search,
  Settings,
  ShoppingBag,
  Tags,
  Trash2,
  Truck,
  X,
} from "lucide-react";
import {
  deleteCategory,
  deleteDeliveryRange,
  deleteProduct,
  loadAdminOrders,
  removeProductImage,
  saveBusinessHours,
  saveCategory,
  saveDeliveryRange,
  saveProduct,
  saveSettings,
  uploadProductImage,
} from "../lib/api";
import { DAY_NAMES } from "../lib/businessHours";
import { validateDeliveryRanges } from "../lib/delivery";

const TABS = [
  ["overview", "Visão geral", LayoutDashboard],
  ["products", "Produtos", PackageCheck],
  ["categories", "Categorias", Tags],
  ["orders", "Pedidos", ShoppingBag],
  ["hours", "Horários", Clock3],
  ["delivery", "Taxas de entrega", Truck],
  ["settings", "Configurações", Settings],
];

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function money(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);
}

function errorMessage(error) {
  if (error?.code === "23505") return "Já existe um registro com esses dados.";
  if (error?.code === "23P01") return "A faixa informada se sobrepõe a outra faixa ativa.";
  if (error?.code === "23503") return "Este registro está sendo usado e não pode ser excluído.";
  return error?.message || "Não foi possível concluir a operação.";
}

export default function AdminPanel({ store, session, reloadStore, showNotice, onSignOut }) {
  const [tab, setTab] = useState("overview");
  const [orders, setOrders] = useState([]);
  const [ordersError, setOrdersError] = useState("");
  const [loadingOrders, setLoadingOrders] = useState(true);

  useEffect(() => {
    let active = true;
    setLoadingOrders(true);
    loadAdminOrders()
      .then((data) => active && setOrders(data))
      .catch((error) => active && setOrdersError(errorMessage(error)))
      .finally(() => active && setLoadingOrders(false));
    return () => {
      active = false;
    };
  }, [session?.user?.id]);

  return (
    <section className="admin-view">
      <div className="admin-session-bar">
        <div>
          <strong>Painel administrativo</strong>
          <small>{session.user.email}</small>
        </div>
        <button type="button" onClick={onSignOut}>
          <LogOut size={17} /> Sair
        </button>
      </div>

      {store.setupWarnings.length > 0 && (
        <div className="admin-warning">
          Execute a migração SQL antes de editar. {store.setupWarnings.join(" ")}
        </div>
      )}

      <nav className="admin-tabs" aria-label="Seções do painel">
        {TABS.map(([id, label, Icon]) => (
          <button key={id} type="button" className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            <Icon size={17} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {tab === "overview" && <Overview store={store} orders={orders} />}
      {tab === "products" && (
        <ProductManager
          products={store.products}
          categories={store.categories}
          reloadStore={reloadStore}
          showNotice={showNotice}
        />
      )}
      {tab === "categories" && (
        <CategoryManager categories={store.categories} reloadStore={reloadStore} showNotice={showNotice} />
      )}
      {tab === "orders" && <Orders orders={orders} loading={loadingOrders} error={ordersError} />}
      {tab === "hours" && (
        <HoursManager hours={store.businessHours} reloadStore={reloadStore} showNotice={showNotice} />
      )}
      {tab === "delivery" && (
        <DeliveryManager
          ranges={store.deliveryRanges}
          settings={store.settings}
          reloadStore={reloadStore}
          showNotice={showNotice}
        />
      )}
      {tab === "settings" && (
        <SettingsManager settings={store.settings} reloadStore={reloadStore} showNotice={showNotice} />
      )}
    </section>
  );
}

function Overview({ store, orders }) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: store.settings.timezone }).format(new Date());
  const todayOrders = orders.filter((order) => order.created_at?.slice(0, 10) === today);
  return (
    <div className="admin-section">
      <div className="admin-section-title"><h2>Visão geral</h2><span>Resumo da operação</span></div>
      <div className="admin-metrics">
        <article><CalendarDays size={22} /><span>Pedidos de hoje</span><strong>{todayOrders.length}</strong></article>
        <article><BadgeCheck size={22} /><span>Produtos</span><strong>{store.products.length}</strong></article>
        <article><Tags size={22} /><span>Categorias</span><strong>{store.categories.length}</strong></article>
        <article><Truck size={22} /><span>Faixas ativas</span><strong>{store.deliveryRanges.filter((item) => item.active).length}</strong></article>
      </div>
      <div className="admin-card">
        <h3>Configuração de entrega</h3>
        <p>
          Distância máxima: {store.settings.maximum_delivery_distance_km ? `${store.settings.maximum_delivery_distance_km} km` : "não definida"}
        </p>
        <p>Regra abaixo de 1 km: {store.settings.below_one_km_behavior || "bloqueada"}</p>
      </div>
    </div>
  );
}

const EMPTY_PRODUCT = {
  id: "",
  name: "",
  description: "",
  price: "",
  category: "",
  image: "",
  status: "Disponível",
  visible: true,
  featured: false,
  sort_order: 0,
};

function ProductManager({ products, categories, reloadStore, showNotice }) {
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [visibilityFilter, setVisibilityFilter] = useState("all");
  const [draft, setDraft] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [file, setFile] = useState(null);
  const [filePreview, setFilePreview] = useState("");

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => () => filePreview && URL.revokeObjectURL(filePreview), [filePreview]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return products.filter((product) => {
      if (term && !product.name.toLowerCase().includes(term)) return false;
      if (categoryFilter !== "all" && product.category !== categoryFilter) return false;
      if (statusFilter !== "all" && product.status !== statusFilter) return false;
      if (visibilityFilter === "visible" && product.visible === false) return false;
      if (visibilityFilter === "hidden" && product.visible !== false) return false;
      return true;
    });
  }, [products, search, categoryFilter, statusFilter, visibilityFilter]);

  function confirmDiscard() {
    return !dirty || window.confirm("Descartar as alterações não salvas?");
  }

  function startNew() {
    if (!confirmDiscard()) return;
    setDraft({ ...EMPTY_PRODUCT, category: categories[0]?.id || "" });
    setIsNew(true);
    setDirty(false);
    setFile(null);
    setFilePreview("");
  }

  function startEdit(product) {
    if (!confirmDiscard()) return;
    setDraft({ ...product });
    setIsNew(false);
    setDirty(false);
    setFile(null);
    setFilePreview("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function change(field, value) {
    setDraft((current) => ({
      ...current,
      [field]: value,
      ...(isNew && field === "name" && !current.id ? { id: slugify(value) } : {}),
    }));
    setDirty(true);
  }

  function selectFile(event) {
    const selected = event.target.files?.[0];
    if (!selected) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(selected.type)) {
      showNotice("Use uma imagem JPG, JPEG, PNG ou WEBP.", "error");
      event.target.value = "";
      return;
    }
    if (selected.size > 5 * 1024 * 1024) {
      showNotice("A imagem deve ter no máximo 5 MB.", "error");
      event.target.value = "";
      return;
    }
    if (filePreview) URL.revokeObjectURL(filePreview);
    setFile(selected);
    setFilePreview(URL.createObjectURL(selected));
    setDirty(true);
  }

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    if (!draft.name.trim() || !draft.id || !draft.category || Number(draft.price) < 0) {
      showNotice("Preencha nome, identificador, categoria e um preço válido.", "error");
      return;
    }
    setSaving(true);
    let uploaded = null;
    const oldImage = isNew ? "" : products.find((item) => item.id === draft.id)?.image;
    try {
      if (file) uploaded = await uploadProductImage(file);
      await saveProduct({ ...draft, image: uploaded?.url || draft.image }, isNew);
      if (uploaded && oldImage && oldImage !== uploaded.url) {
        removeProductImage(oldImage).catch(() => {});
      }
      await reloadStore();
      setDraft(null);
      setDirty(false);
      setFile(null);
      setFilePreview("");
      showNotice(isNew ? "Produto criado com sucesso." : "Produto atualizado com sucesso.", "success");
    } catch (error) {
      if (uploaded) removeProductImage(uploaded.url).catch(() => {});
      showNotice(errorMessage(error), "error");
    } finally {
      setSaving(false);
    }
  }

  async function remove(product) {
    if (!window.confirm(`Excluir “${product.name}”? Essa ação não pode ser desfeita.`)) return;
    try {
      await deleteProduct(product.id);
      await removeProductImage(product.image).catch(() => {});
      await reloadStore();
      showNotice("Produto excluído.", "success");
    } catch (error) {
      showNotice(errorMessage(error), "error");
    }
  }

  return (
    <div className="admin-section">
      <div className="admin-section-title">
        <div><h2>Produtos</h2><span>{filtered.length} de {products.length}</span></div>
        <button className="admin-primary" type="button" onClick={startNew}><Plus size={17} /> Novo produto</button>
      </div>

      {draft && (
        <form className="admin-editor" onSubmit={submit}>
          <div className="editor-heading">
            <h3>{isNew ? "Novo produto" : `Editar ${draft.name}`}</h3>
            <button type="button" onClick={() => confirmDiscard() && setDraft(null)} aria-label="Fechar"><X size={19} /></button>
          </div>
          <div className="product-preview"><img src={filePreview || draft.image} alt="Prévia do produto" /></div>
          <div className="field-row">
            <label>Nome<input required value={draft.name} onChange={(event) => change("name", event.target.value)} /></label>
            <label>Identificador<input required disabled={!isNew} value={draft.id} onChange={(event) => change("id", slugify(event.target.value))} /></label>
          </div>
          <label>Descrição<textarea value={draft.description} onChange={(event) => change("description", event.target.value)} /></label>
          <div className="field-row three">
            <label>Preço (R$)<input type="number" min="0" step="0.01" required value={draft.price} onChange={(event) => change("price", event.target.value)} /></label>
            <label>Categoria<select value={draft.category} onChange={(event) => change("category", event.target.value)}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
            <label>Ordem<input type="number" min="0" step="1" value={draft.sort_order} onChange={(event) => change("sort_order", event.target.value)} /></label>
          </div>
          <label className="upload-field"><ImagePlus size={20} /> Enviar foto da galeria (JPG, PNG ou WEBP, até 5 MB)<input type="file" accept="image/jpeg,image/png,image/webp" onChange={selectFile} /></label>
          <label>Ou usar URL externa<input type="url" value={draft.image} onChange={(event) => change("image", event.target.value)} /></label>
          <div className="field-row three">
            <label>Status<select value={draft.status} onChange={(event) => change("status", event.target.value)}><option>Disponível</option><option>Esgotado</option></select></label>
            <label className="admin-check"><input type="checkbox" checked={draft.visible !== false} onChange={(event) => change("visible", event.target.checked)} /> Visível no cardápio</label>
            <label className="admin-check"><input type="checkbox" checked={Boolean(draft.featured)} onChange={(event) => change("featured", event.target.checked)} /> Produto destacado</label>
          </div>
          <button className="admin-primary wide" type="submit" disabled={saving}><Save size={17} /> {saving ? "Salvando..." : "Salvar produto"}</button>
        </form>
      )}

      <div className="admin-filters">
        <label className="filter-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Pesquisar por nome" /></label>
        <label><ListFilter size={16} /><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">Todas as categorias</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <select aria-label="Filtrar status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">Todos os status</option><option value="Disponível">Disponíveis</option><option value="Esgotado">Esgotados</option></select>
        <select aria-label="Filtrar visibilidade" value={visibilityFilter} onChange={(event) => setVisibilityFilter(event.target.value)}><option value="all">Visíveis e ocultos</option><option value="visible">Somente visíveis</option><option value="hidden">Somente ocultos</option></select>
      </div>

      <div className="admin-product-list">
        {filtered.map((product) => (
          <article key={product.id} className="admin-product-row">
            <img src={product.image} alt="" />
            <div><strong>{product.name}</strong><span>{categories.find((item) => item.id === product.category)?.name || product.category} · {money(product.price)}</span><small>{product.status} · {product.visible === false ? "Oculto" : "Visível"}{product.featured ? " · Destaque" : ""}</small></div>
            <div className="row-actions"><button type="button" onClick={() => startEdit(product)}>Editar</button><button className="danger" type="button" onClick={() => remove(product)}><Trash2 size={16} /></button></div>
          </article>
        ))}
      </div>
      {filtered.length === 0 && <p className="empty">Nenhum produto encontrado.</p>}
    </div>
  );
}

function CategoryManager({ categories, reloadStore, showNotice }) {
  const [draft, setDraft] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const start = (category = null) => {
    setIsNew(!category);
    setDraft(category ? { ...category } : { id: "", name: "", description: "", banner_url: "", sort_order: categories.length + 1, active: true });
  };
  const change = (field, value) => setDraft((current) => ({ ...current, [field]: value, ...(!current.id && field === "name" ? { id: slugify(value) } : {}) }));
  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try { await saveCategory(draft, isNew); await reloadStore(); setDraft(null); showNotice("Categoria salva com sucesso.", "success"); }
    catch (error) { showNotice(errorMessage(error), "error"); }
    finally { setSaving(false); }
  }
  async function remove(category) {
    if (!window.confirm(`Excluir a categoria “${category.name}”?`)) return;
    try { await deleteCategory(category.id); await reloadStore(); showNotice("Categoria excluída.", "success"); }
    catch (error) { showNotice(errorMessage(error), "error"); }
  }
  return (
    <div className="admin-section">
      <div className="admin-section-title"><div><h2>Categorias</h2><span>Organização do cardápio</span></div><button className="admin-primary" type="button" onClick={() => start()}><Plus size={17} /> Nova categoria</button></div>
      {draft && <form className="admin-editor" onSubmit={submit}>
        <div className="editor-heading"><h3>{isNew ? "Nova categoria" : "Editar categoria"}</h3><button type="button" onClick={() => setDraft(null)}><X size={19} /></button></div>
        {draft.banner_url && <div className="category-preview"><img src={draft.banner_url} alt="Prévia" /></div>}
        <div className="field-row"><label>Nome<input required value={draft.name} onChange={(event) => change("name", event.target.value)} /></label><label>Identificador<input disabled={!isNew} required value={draft.id} onChange={(event) => change("id", slugify(event.target.value))} /></label></div>
        <label>Descrição<textarea value={draft.description} onChange={(event) => change("description", event.target.value)} /></label>
        <label>URL do banner<input type="url" value={draft.banner_url} onChange={(event) => change("banner_url", event.target.value)} /></label>
        <div className="field-row"><label>Ordem<input type="number" min="0" value={draft.sort_order} onChange={(event) => change("sort_order", event.target.value)} /></label><label className="admin-check"><input type="checkbox" checked={draft.active !== false} onChange={(event) => change("active", event.target.checked)} /> Categoria ativa</label></div>
        <button className="admin-primary wide" disabled={saving}><Save size={17} /> {saving ? "Salvando..." : "Salvar categoria"}</button>
      </form>}
      <div className="admin-card-list">{categories.map((category) => <article className="category-admin-row" key={category.id}><img src={category.banner_url} alt="" /><div><strong>{category.name}</strong><span>Ordem {category.sort_order} · {category.active ? "Ativa" : "Oculta"}</span></div><div className="row-actions"><button type="button" onClick={() => start(category)}>Editar</button><button className="danger" type="button" onClick={() => remove(category)}><Trash2 size={16} /></button></div></article>)}</div>
    </div>
  );
}

function HoursManager({ hours, reloadStore, showNotice }) {
  const [draft, setDraft] = useState(hours);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(hours), [hours]);
  const change = (day, field, value) => setDraft((current) => current.map((item) => Number(item.day_of_week) === day ? { ...item, [field]: value } : item));
  async function submit(event) {
    event.preventDefault();
    if (draft.some((item) => item.is_open && (!item.opening_time || !item.closing_time))) { showNotice("Informe abertura e fechamento dos dias ativos.", "error"); return; }
    setSaving(true);
    try { await saveBusinessHours(draft); await reloadStore(); showNotice("Horários atualizados.", "success"); }
    catch (error) { showNotice(errorMessage(error), "error"); }
    finally { setSaving(false); }
  }
  return <div className="admin-section"><div className="admin-section-title"><h2>Horários</h2><span>Fuso America/Sao_Paulo</span></div><form className="admin-editor hours-form" onSubmit={submit}>{[0,1,2,3,4,5,6].map((day) => { const item=draft.find((candidate)=>Number(candidate.day_of_week)===day) || {day_of_week:day,is_open:false,opening_time:"",closing_time:""}; return <div className="hours-row" key={day}><strong>{DAY_NAMES[day]}</strong><label className="admin-check"><input type="checkbox" checked={Boolean(item.is_open)} onChange={(event)=>change(day,"is_open",event.target.checked)} /> Aberto</label><label>Abertura<input type="time" disabled={!item.is_open} value={item.opening_time?.slice(0,5)||""} onChange={(event)=>change(day,"opening_time",event.target.value)} /></label><label>Fechamento<input type="time" disabled={!item.is_open} value={item.closing_time?.slice(0,5)||""} onChange={(event)=>change(day,"closing_time",event.target.value)} /></label></div>; })}<button className="admin-primary wide" disabled={saving}><Save size={17} /> {saving?"Salvando...":"Salvar horários"}</button></form></div>;
}

function DeliveryManager({ ranges, settings, reloadStore, showNotice }) {
  const [settingsDraft, setSettingsDraft] = useState(settings);
  const [rangeDraft, setRangeDraft] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => setSettingsDraft(settings), [settings]);
  async function saveRules(event) {
    event.preventDefault();
    if (!settingsDraft.maximum_delivery_distance_km || Number(settingsDraft.maximum_delivery_distance_km) <= 0) { showNotice("Defina uma distância máxima maior que zero.", "error"); return; }
    if (settingsDraft.below_one_km_behavior === "fixed" && (settingsDraft.below_one_km_fee === "" || Number(settingsDraft.below_one_km_fee) < 0)) { showNotice("Defina a taxa fixa abaixo de 1 km.", "error"); return; }
    setSaving(true); try { await saveSettings(settingsDraft); await reloadStore(); showNotice("Regras de entrega salvas.", "success"); } catch(error){showNotice(errorMessage(error),"error");} finally{setSaving(false);}
  }
  function startRange(range=null){setIsNew(!range);setRangeDraft(range?{...range}:{min_distance_km:ranges.length?"":"1.00",max_distance_km:ranges.length?"":"1.99",fee:"",active:true});}
  async function submitRange(event){event.preventDefault();const candidate=isNew?[...ranges,rangeDraft]:ranges.map((item)=>item.id===rangeDraft.id?rangeDraft:item);const validation=validateDeliveryRanges(candidate);if(validation){showNotice(validation,"error");return;}setSaving(true);try{await saveDeliveryRange(rangeDraft,isNew);await reloadStore();setRangeDraft(null);showNotice("Faixa de entrega salva.","success");}catch(error){showNotice(errorMessage(error),"error");}finally{setSaving(false);}}
  async function remove(range){if(!window.confirm("Excluir esta faixa de entrega?"))return;try{await deleteDeliveryRange(range.id);await reloadStore();showNotice("Faixa excluída.","success");}catch(error){showNotice(errorMessage(error),"error");}}
  return <div className="admin-section"><div className="admin-section-title"><h2>Taxas de entrega</h2><span>Valores por distância</span></div>
    <form className="admin-editor" onSubmit={saveRules}><h3>Área e regra abaixo de 1 km</h3><div className="field-row"><label>Comportamento abaixo de 1 km<select value={settingsDraft.below_one_km_behavior} onChange={(event)=>setSettingsDraft({...settingsDraft,below_one_km_behavior:event.target.value})}><option value="blocked">Bloquear</option><option value="free">Grátis</option><option value="fixed">Taxa fixa</option></select></label>{settingsDraft.below_one_km_behavior==="fixed"&&<label>Taxa fixa (R$)<input type="number" min="0" step="0.01" value={settingsDraft.below_one_km_fee??""} onChange={(event)=>setSettingsDraft({...settingsDraft,below_one_km_fee:event.target.value})}/></label>}</div><label>Distância máxima de atendimento (km)<input type="number" min="0.01" step="0.01" value={settingsDraft.maximum_delivery_distance_km??""} onChange={(event)=>setSettingsDraft({...settingsDraft,maximum_delivery_distance_km:event.target.value})}/></label><button className="admin-primary wide" disabled={saving}><Save size={17}/>{saving?"Salvando...":"Salvar regras"}</button></form>
    <div className="admin-section-title compact"><h3>Faixas a partir de 1 km</h3><button className="admin-primary" type="button" onClick={()=>startRange()}><Plus size={17}/>Nova faixa</button></div>
    {rangeDraft&&<form className="admin-editor" onSubmit={submitRange}><div className="editor-heading"><h3>{isNew?"Nova faixa":"Editar faixa"}</h3><button type="button" onClick={()=>setRangeDraft(null)}><X size={19}/></button></div><div className="field-row three"><label>Distância mínima (km)<input type="number" min="1" step="0.01" required value={rangeDraft.min_distance_km} onChange={(event)=>setRangeDraft({...rangeDraft,min_distance_km:event.target.value})}/></label><label>Distância máxima (km)<input type="number" min="1" step="0.01" required value={rangeDraft.max_distance_km} onChange={(event)=>setRangeDraft({...rangeDraft,max_distance_km:event.target.value})}/></label><label>Taxa (R$)<input type="number" min="0" step="0.01" required value={rangeDraft.fee} onChange={(event)=>setRangeDraft({...rangeDraft,fee:event.target.value})}/></label></div><label className="admin-check"><input type="checkbox" checked={rangeDraft.active!==false} onChange={(event)=>setRangeDraft({...rangeDraft,active:event.target.checked})}/>Faixa ativa</label><button className="admin-primary wide" disabled={saving}><Save size={17}/>{saving?"Salvando...":"Salvar faixa"}</button></form>}
    <div className="admin-card-list">{ranges.map((range)=><article className="fee-row" key={range.id}><div><strong>{Number(range.min_distance_km).toFixed(2)} a {Number(range.max_distance_km).toFixed(2)} km</strong><span>{money(range.fee)} · {range.active?"Ativa":"Inativa"}</span></div><div className="row-actions"><button type="button" onClick={()=>startRange(range)}>Editar</button><button className="danger" type="button" onClick={()=>remove(range)}><Trash2 size={16}/></button></div></article>)}</div>{ranges.length===0&&<p className="empty">Nenhuma faixa cadastrada. Entregas a partir de 1 km permanecerão bloqueadas.</p>}
  </div>;
}

function SettingsManager({ settings, reloadStore, showNotice }) {
  const [draft,setDraft]=useState(settings);const [saving,setSaving]=useState(false);useEffect(()=>setDraft(settings),[settings]);const change=(field,value)=>setDraft({...draft,[field]:value});async function submit(event){event.preventDefault();setSaving(true);try{await saveSettings(draft);await reloadStore();showNotice("Configurações salvas.","success");}catch(error){showNotice(errorMessage(error),"error");}finally{setSaving(false);}}
  return <div className="admin-section"><div className="admin-section-title"><h2>Configurações</h2><span>Dados públicos do estabelecimento</span></div><form className="admin-editor" onSubmit={submit}><label>Nome do estabelecimento<input required value={draft.store_name||""} onChange={(event)=>change("store_name",event.target.value)}/></label><label>WhatsApp com DDI e DDD<input required inputMode="numeric" value={draft.whatsapp_number||""} onChange={(event)=>change("whatsapp_number",event.target.value.replace(/\D/g,""))}/></label><div className="field-row"><label>Latitude da loja<input type="number" step="any" required value={draft.store_latitude??""} onChange={(event)=>change("store_latitude",event.target.value)}/></label><label>Longitude da loja<input type="number" step="any" required value={draft.store_longitude??""} onChange={(event)=>change("store_longitude",event.target.value)}/></label></div><div className="field-row"><label>Nome Pix<input value={draft.pix_name||""} onChange={(event)=>change("pix_name",event.target.value)}/></label><label>Chave Pix<input value={draft.pix_key||""} onChange={(event)=>change("pix_key",event.target.value)}/></label></div><label>URL do QR Code Pix<input type="url" value={draft.pix_qr_code_url||""} onChange={(event)=>change("pix_qr_code_url",event.target.value)}/></label><label>URL do logo<input type="url" value={draft.brand_logo_url||""} onChange={(event)=>change("brand_logo_url",event.target.value)}/></label><label>URL do banner principal<input type="url" value={draft.brand_hero_url||""} onChange={(event)=>change("brand_hero_url",event.target.value)}/></label><label>Taxa de cartão (%)<input type="number" min="0" step="0.01" value={draft.card_fee_percent??0} onChange={(event)=>change("card_fee_percent",event.target.value)}/></label><button className="admin-primary wide" disabled={saving}><Save size={17}/>{saving?"Salvando...":"Salvar configurações"}</button></form></div>;
}

function Orders({ orders, loading, error }) {
  return <div className="admin-section"><div className="admin-section-title"><h2>Pedidos</h2><span>Últimos 100 pedidos</span></div>{loading&&<p className="empty">Carregando pedidos...</p>}{error&&<div className="admin-warning">{error}</div>}<div className="orders-list">{orders.map((order)=><article key={order.id} className="admin-card"><div className="order-heading"><strong>#{String(order.id).slice(0,8)} · {order.customer_name}</strong><span>{money(order.total)}</span></div><small>{new Date(order.created_at).toLocaleString("pt-BR")} · {order.delivery_type} · {order.payment_method}</small><p>{(order.order_items||[]).map((item)=>`${item.quantity}x ${item.product_name}`).join(", ")}</p>{order.distance_km!=null&&<small>Distância: {Number(order.distance_km).toFixed(2)} km · Entrega: {money(order.delivery_fee)}</small>}</article>)}</div>{!loading&&!error&&orders.length===0&&<p className="empty">Nenhum pedido salvo no Supabase.</p>}</div>;
}
