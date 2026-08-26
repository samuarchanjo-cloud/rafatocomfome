import React, { useEffect, useState } from "react";
import { ArrowLeft, House, LogIn, LogOut, MapPin, PackageOpen, RotateCcw, Save, Shield, UserRound } from "lucide-react";

function money(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);
}

const EMPTY_ADDRESS = {
  label: "Casa", street: "", number: "", complement: "", reference: "",
  neighborhood: "", city: "", state: "", postcode: "", is_default: true,
};

export default function CustomerAccount({
  session, account, loading, adminAuthorized, onBack, onLogin, onSignOut,
  onSaveProfile, onSaveAddress, onDeleteAddress, onUseAddress, onRepeatOrder, onNewOrder, onOpenAdmin,
}) {
  const [login, setLogin] = useState({ email: "", password: "" });
  const [profile, setProfile] = useState({ name: "", phone: "", email: "" });
  const [address, setAddress] = useState(EMPTY_ADDRESS);
  const [busy, setBusy] = useState(false);
  const [openOrderId, setOpenOrderId] = useState(null);

  useEffect(() => {
    setProfile({
      name: account.profile?.name || session?.user?.user_metadata?.name || "",
      phone: account.profile?.phone || session?.user?.user_metadata?.phone || "",
      email: account.profile?.email || session?.user?.email || "",
    });
  }, [account.profile, session]);

  async function submitLogin(event) {
    event.preventDefault();
    setBusy(true);
    try { await onLogin(login.email, login.password); }
    finally { setBusy(false); }
  }

  async function submitProfile(event) {
    event.preventDefault();
    setBusy(true);
    try { await onSaveProfile(profile); }
    finally { setBusy(false); }
  }

  async function submitAddress(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await onSaveAddress(address);
      setAddress(EMPTY_ADDRESS);
    } finally { setBusy(false); }
  }

  if (!session) {
    return <section className="account-view">
      <button className="back-button" onClick={onBack}><ArrowLeft size={18} />Voltar</button>
      <div className="section-title"><h1>Minha conta</h1><span>Entre para acessar endereços e pedidos</span></div>
      <form className="account-card account-login" onSubmit={submitLogin}>
        <LogIn size={28} />
        <label>E-mail<input required type="email" autoComplete="email" value={login.email} onChange={(event) => setLogin({ ...login, email: event.target.value })} /></label>
        <label>Senha<input required type="password" autoComplete="current-password" value={login.password} onChange={(event) => setLogin({ ...login, password: event.target.value })} /></label>
        <button className="primary-action" disabled={busy}>{busy ? "Entrando..." : "Entrar"}</button>
        <small>Você pode comprar sem conta. O cadastro opcional aparece no checkout.</small>
      </form>
    </section>;
  }

  return <section className="account-view">
    <button className="back-button" onClick={onBack}><ArrowLeft size={18} />Voltar</button>
    <div className="section-title"><h1>Minha conta</h1><span>Seus dados, endereços e pedidos</span></div>
    {loading && <p className="empty">Carregando sua conta...</p>}
    {account.setupRequired && <div className="form-error">Execute a nova migration para habilitar o cadastro de clientes.</div>}

    <form className="account-card" onSubmit={submitProfile}>
      <h2><UserRound size={20} /> Meu perfil</h2>
      <label>Nome<input required autoComplete="name" value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} /></label>
      <label>Telefone<input required inputMode="tel" autoComplete="tel" value={profile.phone} onChange={(event) => setProfile({ ...profile, phone: event.target.value })} /></label>
      <label>E-mail<input readOnly type="email" value={profile.email} /></label>
      <button type="submit" className="secondary-action" disabled={busy}><Save size={17} />Salvar perfil</button>
    </form>

    <div className="account-card">
      <h2><MapPin size={20} /> Meus endereços</h2>
      <div className="saved-address-list">
        {account.addresses.map((item) => <article key={item.id}>
          <div><strong>{item.label}{item.is_default ? " · padrão" : ""}</strong><span>{item.street}, {item.number}</span><small>{[item.complement, item.neighborhood, item.city].filter(Boolean).join(" · ")}</small></div>
          <div className="saved-address-actions">
            <button type="button" onClick={() => onUseAddress(item)}><House size={16} />Usar</button>
            <button type="button" onClick={() => setAddress(item)}>Editar</button>
            <button type="button" className="ghost-danger" onClick={() => onDeleteAddress(item.id)}>Excluir</button>
          </div>
        </article>)}
        {!account.addresses.length && <p className="empty">Nenhum endereço salvo.</p>}
      </div>
      {account.profile ? <form className="address-editor" onSubmit={submitAddress}>
        <strong>{address.id ? "Editar endereço" : "Adicionar endereço"}</strong>
        <label>Nome do endereço<input required value={address.label || ""} onChange={(event) => setAddress({ ...address, label: event.target.value })} placeholder="Casa, Trabalho..." /></label>
        <div className="address-row"><label>Rua<input required value={address.street || ""} onChange={(event) => setAddress({ ...address, street: event.target.value })} /></label><label>Número<input required value={address.number || ""} onChange={(event) => setAddress({ ...address, number: event.target.value })} /></label></div>
        <label>Complemento / referência<input value={address.complement || ""} onChange={(event) => setAddress({ ...address, complement: event.target.value })} /></label>
        <div className="address-row"><label>Bairro<input value={address.neighborhood || ""} onChange={(event) => setAddress({ ...address, neighborhood: event.target.value })} /></label><label>CEP<input inputMode="numeric" value={address.postcode || ""} onChange={(event) => setAddress({ ...address, postcode: event.target.value })} /></label></div>
        <div className="address-row"><label>Cidade<input value={address.city || ""} onChange={(event) => setAddress({ ...address, city: event.target.value })} /></label><label>Estado<input value={address.state || ""} onChange={(event) => setAddress({ ...address, state: event.target.value })} /></label></div>
        <label className="inline-check"><input type="checkbox" checked={address.is_default !== false} onChange={(event) => setAddress({ ...address, is_default: event.target.checked })} />Definir como padrão</label>
        <button className="secondary-action" disabled={busy}><Save size={17} />Salvar endereço</button>
      </form> : <small>Salve seu perfil antes de adicionar um endereço.</small>}
    </div>

    <div className="account-card">
      <h2><PackageOpen size={20} /> Meus pedidos</h2>
      <div className="customer-orders">
        {account.orders.map((order) => <article key={order.id}>
          <div className="order-heading"><strong>#{String(order.id).slice(0, 8)}</strong><b>{money(order.total)}</b></div>
          <small>{new Date(order.created_at).toLocaleString("pt-BR")} · {order.status || "novo"}</small>
          <p>{(order.order_items || []).map((item) => `${item.quantity}x ${item.product_name}`).join(", ")}</p>
          {openOrderId === order.id && <div className="order-details">{order.address && <small>{order.address}</small>}<small>Subtotal: {money(order.subtotal)} · Entrega: {money(order.delivery_fee)}</small><small>Pagamento: {order.payment_method}</small></div>}
          <div className="saved-address-actions"><button type="button" onClick={() => setOpenOrderId((current) => current === order.id ? null : order.id)}>{openOrderId === order.id ? "Ocultar" : "Ver pedido"}</button><button type="button" onClick={() => onRepeatOrder(order)}><RotateCcw size={16} />Repetir pedido</button></div>
        </article>)}
        {!account.orders.length && <p className="empty">Você ainda não possui pedidos vinculados.</p>}
      </div>
    </div>

    <div className="account-actions">
      <button type="button" onClick={onNewOrder}><PackageOpen size={17} />Fazer novo pedido</button>
      {adminAuthorized && <button type="button" onClick={onOpenAdmin}><Shield size={17} />Abrir Admin</button>}
      <button type="button" onClick={onSignOut}><LogOut size={17} />Sair</button>
    </div>
  </section>;
}
