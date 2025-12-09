import React, { useEffect, useState } from 'react';
import { apiGet } from '../lib/api.js';
import { Link } from 'react-router-dom';

export default function Clients() {
  const [dni, setDni] = useState('');
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (dni) params.set('dni', dni);
      const qs = params.toString();
      const data = await apiGet(qs ? `/clients?${qs}` : '/clients');
      setClients(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="section">
      <div className="card mb-4">
        <div className="form-row">
          <input className="input" placeholder="Buscar por DNI" value={dni} onChange={(e)=>setDni(e.target.value)} />
          <button className="btn btn-primary" onClick={load} disabled={loading}>Buscar</button>
        </div>
      </div>

      <div className="card table-flush">
        <table className="table">
          <thead>
            <tr>
              <th>DNI</th>
              <th>Nombre</th>
              <th>Apellidos</th>
              <th>Préstamos</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {clients.map(c => (
              <tr key={c.id}>
                <td>{c.dni}</td>
                <td>{c.firstName}</td>
                <td>{c.lastName}</td>
                <td>{c.loans?.length || 0}</td>
                <td>
                  <Link className="btn btn-sm" to={`/clients/${c.id}`}>Ver préstamos</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

