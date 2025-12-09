import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiGet, apiFileUrl } from '../lib/api.js';
import { formatDate } from '../lib/date.js';

export default function ClientDetail() {
  const { id } = useParams();
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const data = await apiGet(`/clients/${id}`);
        setClient(data);
      } catch (e) {
        setError('No se pudo cargar el cliente');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id]);

  if (loading) return <div>Cargando...</div>;
  if (error) return <div className="badge badge-red">{error}</div>;
  if (!client) return null;

  const token = localStorage.getItem('token') || '';
  const labelTermUnit = (_u, n) => (n === 1 ? 'mes' : 'meses');

  return (
    <div className="section">
      <div className="card mb-4">
        <div className="mb-2">
          <strong>{client.firstName} {client.lastName}</strong> - DNI {client.dni}
        </div>
        <Link to="/clients" className="btn">Volver a clientes</Link>
      </div>

      <div className="card mb-3">
        <h4 style={{ marginTop: 0 }}>Préstamos ({client.loans?.length || 0})</h4>
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Fecha inicio</th>
              <th>Monto</th>
              <th>Tasa anual</th>
              <th>Plazo</th>
              <th>Creado por</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {(client.loans || []).map((l) => (
              <tr key={l.id}>
                <td>{l.id}</td>
                <td>{formatDate(l.startDate)}</td>
                <td>{Number(l.principal).toFixed(2)}</td>
                <td>{(Number(l.interestRate) * 100).toFixed(2)}%</td>
                <td>{l.termCount} {labelTermUnit(null, l.termCount)}</td>
                <td>{l.createdBy?.username || '-'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <Link
                    to={`/loans/${l.id}`}
                    className="btn btn-primary btn-sm"
                    style={{ marginRight: 8 }}
                  >
                    Ver detalle
                  </Link>
                  <a
                    className="btn btn-sm"
                    href={apiFileUrl(`/loans/${l.id}/schedule.pdf?token=${encodeURIComponent(token)}`)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    PDF
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

