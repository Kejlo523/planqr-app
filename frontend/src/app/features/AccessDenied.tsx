import { Link, useLocation } from 'react-router-dom';
import { PlanQrBrand } from '../layout/WorkspaceHeader';
import '../layout/LoginPanel.css';

export default function AccessDenied() {
  const location = useLocation();
  const reason = (location.state as { reason?: 'admin' | 'lecturer' } | null)?.reason;

  const message =
    reason === 'admin'
      ? 'To konto nie ma uprawnień do panelu administratora.'
      : reason === 'lecturer'
        ? 'To konto nie ma uprawnień do panelu dydaktyka.'
        : 'To konto nie ma dostępu do tej strony.';

  return (
    <main className="access-denied">
      <section aria-labelledby="access-denied-title">
        <PlanQrBrand />
        <h1 id="access-denied-title">Brak dostępu</h1>
        <p>{message}</p>
        <Link to="/" className="login-panel__btn">Wróć do logowania</Link>
      </section>
    </main>
  );
}
