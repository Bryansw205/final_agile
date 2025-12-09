import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, Link } from 'react-router-dom';
import App from './App.jsx';
import Login from './pages/Login.es.jsx';
import NewLoan from './pages/NewLoan.jsx';
import Clients from './pages/Clients.jsx';
import LoanDetail from './pages/LoanDetail.jsx';
import ClientDetail from './pages/ClientDetail.jsx';
import CashSession from './pages/CashSession.jsx';
import './styles.css';

// Optional: enable full-page background image via localStorage key 'bgImageUrl'
const bgUrl = localStorage.getItem('bgImageUrl');
if (bgUrl) {
  document.body.classList.add('has-bg-image');
  document.documentElement.style.setProperty('--bg-image-url', `url("${bgUrl}")`);
  const overlay = localStorage.getItem('bgImageOverlay') || 'rgba(255,255,255,0.7)';
  document.documentElement.style.setProperty('--bg-overlay', overlay);
}

function RequireAuth({ children }) {
  const token = localStorage.getItem('token');
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<App />}>
          <Route index element={<RequireAuth><NewLoan /></RequireAuth>} />
          <Route path="clients" element={<RequireAuth><Clients /></RequireAuth>} />
          <Route path="clients/:id" element={<RequireAuth><ClientDetail /></RequireAuth>} />
          <Route path="loans/:id" element={<RequireAuth><LoanDetail /></RequireAuth>} />
          <Route path="cash-session" element={<RequireAuth><CashSession /></RequireAuth>} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
