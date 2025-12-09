import React from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';

export default function App() {
  const navigate = useNavigate();
  const [hasLogo, setHasLogo] = React.useState(true);
  const [showUserMenu, setShowUserMenu] = React.useState(false);
  const [showPwdModal, setShowPwdModal] = React.useState(false);
  const [currPwd, setCurrPwd] = React.useState('');
  const [newPwd, setNewPwd] = React.useState('');
  const [newPwd2, setNewPwd2] = React.useState('');
  const [pwdMsg, setPwdMsg] = React.useState('');
  const [showCurr, setShowCurr] = React.useState(false);
  const [showNew, setShowNew] = React.useState(false);
  const [showNew2, setShowNew2] = React.useState(false);

  React.useEffect(() => {
    const img = new Image();
    img.onload = () => setHasLogo(true);
    img.onerror = () => setHasLogo(false);
    img.src = '/logo.png';
  }, []);

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    navigate('/login');
  };

  const user = (() => { try { return JSON.parse(localStorage.getItem('user') || '{}'); } catch { return {}; } })();
  const username = user.username || '';
  const initial = (username || '?').slice(0,1).toUpperCase();
  const toggleMenu = () => setShowUserMenu(v => !v);
  const closeMenu = () => setShowUserMenu(false);
  const openChangePwd = () => { setShowPwdModal(true); setPwdMsg(''); setCurrPwd(''); setNewPwd(''); setNewPwd2(''); setShowUserMenu(false); };

  const savePassword = async () => {
    setPwdMsg('');
    if (!currPwd) { setPwdMsg('Ingrese su contraseña actual'); return; }
    if (newPwd.length < 8) { setPwdMsg('La nueva contraseña debe tener al menos 8 caracteres'); return; }
    if (newPwd !== newPwd2) { setPwdMsg('La confirmación no coincide'); return; }
    try {
      const token = localStorage.getItem('token') || '';
      const res = await fetch((import.meta.env.VITE_API_URL || 'http://localhost:3000') + '/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword: currPwd, newPassword: newPwd })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'No se pudo cambiar la contraseña');
      setPwdMsg('Contraseña actualizada');
      setTimeout(() => setShowPwdModal(false), 900);
    } catch (e) {
      setPwdMsg(e.message || 'Error al cambiar contraseña');
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          {hasLogo ? (
            <img className="brand-logo" src="/logo.png" alt="Logo" />
          ) : (
            <div className="brand-badge">GP</div>
          )}
          Gestión de Préstamos
        </div>
        <nav className="nav">
          <NavLink to="/" end className={({isActive})=> isActive? 'active' : ''}>Nuevo Préstamo</NavLink>
          <NavLink to="/clients" className={({isActive})=> isActive? 'active' : ''}>Clientes</NavLink>
          <NavLink to="/cash-session" className={({isActive})=> isActive? 'active' : ''}>Caja</NavLink>
        </nav>

        <div className="push-bottom user-area">
          <div className="user-card" onClick={toggleMenu} role="button" aria-haspopup="true" aria-expanded={showUserMenu}>
            <div className="user-info">
              <div className="user-avatar" aria-hidden>{initial}</div>
              <div className="user-text">
                <div style={{fontWeight:700, lineHeight:1}}>{username}</div>
                <div className="muted" style={{fontSize:12, lineHeight:1}}>Sesión activa</div>
              </div>
            </div>
            <button className="icon-btn" title="Salir" onClick={(e)=>{e.stopPropagation(); logout();}} aria-label="Salir">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M15 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M10 17l5-5-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M15 12H3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
          {showUserMenu && (<div className="backdrop" onClick={closeMenu} />)}
          <div className={"user-menu" + (showUserMenu ? " open" : "") }>
            <button className="dropdown-item" onClick={openChangePwd}>Cambiar contraseña</button>
          </div>
        </div>
      </aside>
      <main className="content">
        <div className="topbar">
          <h1 className="muted">Panel</h1>
        </div>
        <Outlet />
      </main>

      {showPwdModal && (
        <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,.35)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000}} onClick={()=>setShowPwdModal(false)}>
          <div className="card" style={{width:420}} onClick={(e)=>e.stopPropagation()}>
            <h3 style={{marginBottom:12}}>Cambiar contraseña</h3>
            <div className="form" style={{gap:12}}>
              <div>
                <div className="label">Contraseña actual</div>
                <div className="input-wrap">
                  <input className="input" type={showCurr ? 'text' : 'password'} value={currPwd} onChange={(e)=>setCurrPwd(e.target.value)} />
                  <button type="button" className="eye-btn" onClick={()=>setShowCurr(v=>!v)} aria-label="Mostrar/Ocultar contraseña actual">
                    {showCurr ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z" stroke="currentColor" strokeWidth="2"/>
                        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2"/>
                        <path d="M3 3l18 18" stroke="currentColor" strokeWidth="2"/>
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z" stroke="currentColor" strokeWidth="2"/>
                        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2"/>
                      </svg>
                    )}
                  </button>
                </div>
              </div>
              <div>
                <div className="label">Nueva contraseña (mínimo 8)</div>
                <div className="input-wrap">
                  <input className="input" type={showNew ? 'text' : 'password'} value={newPwd} onChange={(e)=>setNewPwd(e.target.value)} />
                  <button type="button" className="eye-btn" onClick={()=>setShowNew(v=>!v)} aria-label="Mostrar/Ocultar nueva contraseña">
                    {showNew ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z" stroke="currentColor" strokeWidth="2"/>
                        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2"/>
                        <path d="M3 3l18 18" stroke="currentColor" strokeWidth="2"/>
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z" stroke="currentColor" strokeWidth="2"/>
                        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2"/>
                      </svg>
                    )}
                  </button>
                </div>
              </div>
              <div>
                <div className="label">Confirmar nueva contraseña</div>
                <div className="input-wrap">
                  <input className="input" type={showNew2 ? 'text' : 'password'} value={newPwd2} onChange={(e)=>setNewPwd2(e.target.value)} />
                  <button type="button" className="eye-btn" onClick={()=>setShowNew2(v=>!v)} aria-label="Mostrar/Ocultar confirmación">
                    {showNew2 ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z" stroke="currentColor" strokeWidth="2"/>
                        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2"/>
                        <path d="M3 3l18 18" stroke="currentColor" strokeWidth="2"/>
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z" stroke="currentColor" strokeWidth="2"/>
                        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2"/>
                      </svg>
                    )}
                  </button>
                </div>
              </div>
              {pwdMsg && <div className="muted" style={{color: pwdMsg.includes('actualizada') ? 'green' : 'red'}}>{pwdMsg}</div>}
              <div className="form-row" style={{justifyContent:'flex-end'}}>
                <button className="btn" onClick={()=>setShowPwdModal(false)}>Cancelar</button>
                <button className="btn btn-primary" onClick={savePassword}>Guardar cambios</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}





